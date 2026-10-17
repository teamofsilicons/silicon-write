//! Live docs. Every open doc is one Yjs document in memory (a "room"); everyone connected to it
//! shares it through the y-websocket protocol, and every change any of them (or the service, on
//! someone's behalf) makes is stored as the update its transaction made, with its author, in order.
//!
//! - Each Yjs client id belongs to exactly one account (`doc_clients`), which is how "who wrote
//!   this" works. A connection can't write as a client id another account owns.
//! - Server edits (a Silicon's edit, a restore, a suggestion accepted) are made on a copy of the doc
//!   with a fresh client id for the author, then merged in: they arrive like anyone's typing.
//! - Viewers can't change the doc. Commenters can only add or remove their own suggestions.
//!
//! One service instance serves a doc at a time (rooms live in memory).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::ws::{CloseFrame, Message as WsMessage, WebSocket};
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::{Mutex, mpsc};
use write_doc::ydoc;
use yrs::encoding::read::Cursor;
use yrs::sync::awareness::{AwarenessUpdate, AwarenessUpdateEntry};
use yrs::sync::{Message, MessageReader, SyncMessage};
use yrs::updates::decoder::{Decode, DecoderV1};
use yrs::updates::encoder::{Encode, Encoder, EncoderV1};
use yrs::{ReadTxn, StateVector, Transact, Update};

use crate::access::Role;
use crate::accounts::{self, Account};
use crate::error::{ApiError, ApiResult};
use crate::ids;
use crate::state::AppState;

/// Server-to-client JSON messages travel as y-websocket message type 100.
pub const MSG_EVENT: u8 = 100;
const CHECKPOINT_EVERY: i64 = 200;

mod validation;

fn access_closed() -> WsMessage {
    WsMessage::Close(Some(CloseFrame {
        code: 4403,
        reason: "You no longer have access to this doc.".into(),
    }))
}

#[derive(Default)]
pub struct Rooms {
    map: Mutex<HashMap<String, Arc<Room>>>,
}

pub struct Room {
    pub doc_id: String,
    pub inner: Mutex<RoomState>,
    /// When the room was last asked for (milliseconds), so an idle room is never dropped while a request is about to
    /// use it.
    touched: std::sync::atomic::AtomicU64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub struct Conn {
    pub tx: mpsc::UnboundedSender<WsMessage>,
    pub account: Option<Account>,
    pub role: Role,
    /// Awareness client ids this connection announced.
    pub awareness: HashSet<u64>,
}

pub struct RoomState {
    pub ydoc: yrs::Doc,
    captured: Arc<std::sync::Mutex<Vec<Vec<u8>>>>,
    pub seq: i64,
    last_checkpoint: i64,
    /// Yjs client id → account uuid.
    pub clients: HashMap<u64, String>,
    pub conns: HashMap<u64, Conn>,
    awareness: HashMap<u64, (u32, String)>,
    /// Accounts that changed the doc through the API lately (a Silicon at the command line), shown
    /// among the people in the doc like anyone typing in it, by account uuid.
    visitors: HashMap<String, Visitor>,
    last_used: Instant,
    pub deleted: bool,
    index_due: Option<Instant>,
    /// Storing a change failed after it was applied here: the room no longer matches what's stored, so it is
    /// reloaded on next use and everyone reconnects (their editors send their changes again).
    poisoned: bool,
}

/// What a stored change was made by.
#[derive(Clone, Copy)]
pub enum Origin {
    Live,
    Edit,
    Create,
    Import,
    Restore,
    Suggestion,
    Review,
    Undo,
}

impl Origin {
    fn as_str(self) -> &'static str {
        match self {
            Origin::Live => "live",
            Origin::Edit => "edit",
            Origin::Create => "create",
            Origin::Import => "import",
            Origin::Restore => "restore",
            Origin::Suggestion => "suggestion",
            Origin::Review => "review",
            Origin::Undo => "undo",
        }
    }
}

fn encode(message: &Message) -> Vec<u8> {
    let mut encoder = EncoderV1::new();
    message.encode(&mut encoder);
    encoder.to_vec()
}

pub fn event_message(value: &Value) -> Vec<u8> {
    encode(&Message::Custom(
        MSG_EVENT,
        serde_json::to_vec(value).unwrap_or_default(),
    ))
}

impl Rooms {
    /// The room for a doc, loading it from storage when nobody has it open.
    pub async fn get(&self, state: &AppState, doc_id: &str) -> ApiResult<Arc<Room>> {
        let mut map = self.map.lock().await;
        if let Some(room) = map.get(doc_id) {
            let poisoned = room
                .inner
                .try_lock()
                .map(|inner| inner.poisoned)
                .unwrap_or(false);
            if !poisoned {
                room.touched
                    .store(now_ms(), std::sync::atomic::Ordering::Relaxed);
                return Ok(room.clone());
            }
            map.remove(doc_id);
        }
        let room = Arc::new(load(state, doc_id).await?);
        map.insert(doc_id.to_owned(), room.clone());
        Ok(room)
    }

    /// Sends a JSON event to everyone with the doc open.
    pub async fn notify(&self, doc_id: &str, event: Value) {
        let room = self.map.lock().await.get(doc_id).cloned();
        if let Some(room) = room {
            let bytes = event_message(&event);
            let inner = room.inner.lock().await;
            for conn in inner.conns.values() {
                let _ = conn.tx.send(WsMessage::Binary(bytes.clone().into()));
            }
        }
    }

    /// Recomputes every connection's role after sharing changed; connections that lost access are closed.
    pub async fn recheck(&self, state: &AppState, doc_id: &str) {
        let room = self.map.lock().await.get(doc_id).cloned();
        let Some(room) = room else { return };
        let Ok(doc) = crate::access::load_doc(state, doc_id).await else {
            return;
        };
        let mut inner = room.inner.lock().await;
        inner.deleted = doc.deleted_at.is_some();
        let mut closed = vec![];
        for (id, conn) in inner.conns.iter_mut() {
            let caller = conn.account.as_ref().map(|a| crate::auth::Caller {
                uuid: a.uuid.clone(),
                id: a.id.clone(),
                kind: a.kind.clone(),
                token: String::new(),
            });
            match crate::access::doc_role(state, caller.as_ref(), &doc).await {
                Ok(Some(role)) => {
                    if role != conn.role {
                        conn.role = role;
                        let _ = conn.tx.send(WsMessage::Binary(
                            event_message(&json!({ "type": "role", "role": role.as_str() })).into(),
                        ));
                    }
                }
                _ => {
                    let _ = conn.tx.send(WsMessage::Binary(
                        event_message(&json!({ "type": "role", "role": null })).into(),
                    ));
                    let _ = conn.tx.send(access_closed());
                    closed.push(*id);
                }
            }
        }
        for id in closed {
            inner.remove_connection(id);
        }
    }

    /// Drops rooms nobody has had open for a while, and indexes changed docs.
    pub async fn maintain(&self, state: &AppState) {
        let rooms: Vec<Arc<Room>> = self.map.lock().await.values().cloned().collect();
        for room in &rooms {
            let due = {
                let mut inner = room.inner.lock().await;
                inner.end_visits();
                inner.index_due.is_some_and(|t| t <= Instant::now())
            };
            if due && let Err(e) = index(state, room).await {
                tracing::warn!(doc = %room.doc_id, error = %e.message, "indexing failed");
            }
        }
        let mut map = self.map.lock().await;
        let mut idle = vec![];
        let recently = now_ms().saturating_sub(600_000);
        for (id, room) in map.iter() {
            if room.touched.load(std::sync::atomic::Ordering::Relaxed) > recently {
                continue;
            }
            if let Ok(inner) = room.inner.try_lock() {
                let idle_room = inner.conns.is_empty()
                    && inner.index_due.is_none()
                    && inner.last_used.elapsed() > Duration::from_secs(600);
                if idle_room || inner.poisoned {
                    idle.push(id.clone());
                }
            }
        }
        for id in idle {
            map.remove(&id);
        }
    }

    /// Forgets a room (after its doc is permanently deleted).
    pub async fn drop_room(&self, doc_id: &str) {
        let room = self.map.lock().await.remove(doc_id);
        if let Some(room) = room {
            let inner = room.inner.lock().await;
            for conn in inner.conns.values() {
                let _ = conn.tx.send(WsMessage::Binary(
                    event_message(&json!({ "type": "role", "role": null })).into(),
                ));
                let _ = conn.tx.send(access_closed());
            }
        }
    }
}

async fn load(state: &AppState, doc_id: &str) -> ApiResult<Room> {
    let doc = crate::access::load_doc(state, doc_id).await?;
    let ydoc = ydoc::new_ydoc(1);
    let checkpoint: Option<(i64, Vec<u8>)> = sqlx::query_as(
        "select seq, state from doc_checkpoints where doc_id = $1 order by seq desc limit 1",
    )
    .bind(doc_id)
    .fetch_optional(&state.db)
    .await?;
    let from = checkpoint.as_ref().map(|c| c.0).unwrap_or(0);
    let updates: Vec<(i64, Vec<u8>)> = sqlx::query_as(
        "select seq, update from doc_updates where doc_id = $1 and seq > $2 order by seq",
    )
    .bind(doc_id)
    .bind(from)
    .fetch_all(&state.db)
    .await?;
    {
        let mut txn = ydoc.transact_mut();
        if let Some((_, bytes)) = &checkpoint {
            txn.apply_update(Update::decode_v1(bytes).map_err(ApiError::internal)?)
                .map_err(ApiError::internal)?;
        }
        for (_, bytes) in &updates {
            txn.apply_update(Update::decode_v1(bytes).map_err(ApiError::internal)?)
                .map_err(ApiError::internal)?;
        }
    }
    let seq = updates.last().map(|u| u.0).unwrap_or(from).max(doc.seq);
    let clients: Vec<(i64, String)> =
        sqlx::query_as("select client_id, author_uuid from doc_clients where doc_id = $1")
            .bind(doc_id)
            .fetch_all(&state.db)
            .await?;
    let captured = Arc::new(std::sync::Mutex::new(vec![]));
    let sink = captured.clone();
    ydoc.observe_update_v1(
        "store",
        move |_: &yrs::TransactionMut, e: &yrs::UpdateEvent| {
            sink.lock().unwrap().push(e.update.clone());
        },
    )
    .map_err(ApiError::internal)?;
    Ok(Room {
        doc_id: doc_id.to_owned(),
        touched: std::sync::atomic::AtomicU64::new(now_ms()),
        inner: Mutex::new(RoomState {
            ydoc,
            captured,
            seq,
            last_checkpoint: from,
            clients: clients.into_iter().map(|(c, a)| (c as u64, a)).collect(),
            conns: HashMap::new(),
            awareness: HashMap::new(),
            visitors: HashMap::new(),
            last_used: Instant::now(),
            deleted: doc.deleted_at.is_some(),
            index_due: None,
            poisoned: false,
        }),
    })
}

impl RoomState {
    fn remove_connection(&mut self, id: u64) {
        if let Some(conn) = self.conns.remove(&id) {
            for client in conn.awareness {
                if let Some((clock, _)) = self.awareness.remove(&client) {
                    self.send_awareness(client, clock.saturating_add(1), "null");
                }
            }
        }
    }

    pub fn read(&self) -> write_doc::Doc {
        ydoc::read_doc(&self.ydoc)
    }

    fn full_state(&self) -> Vec<u8> {
        self.ydoc
            .transact()
            .encode_state_as_update_v1(&StateVector::default())
    }

    /// Stores what the last transactions changed and sends it to everyone else.
    async fn commit(
        &mut self,
        state: &AppState,
        doc_id: &str,
        author: &str,
        origin: Origin,
        skip_conn: Option<u64>,
    ) -> ApiResult<Vec<i64>> {
        let seq_before = self.seq;
        match self.store(state, doc_id, author, origin, skip_conn).await {
            Ok(seqs) => Ok(seqs),
            Err(error) => {
                // What's in memory now differs from what's stored: start again from storage.
                self.seq = seq_before;
                self.poisoned = true;
                for conn in self.conns.values() {
                    let _ = conn.tx.send(WsMessage::Close(None));
                }
                Err(error)
            }
        }
    }

    async fn store(
        &mut self,
        state: &AppState,
        doc_id: &str,
        author: &str,
        origin: Origin,
        skip_conn: Option<u64>,
    ) -> ApiResult<Vec<i64>> {
        let updates: Vec<Vec<u8>> = std::mem::take(&mut *self.captured.lock().unwrap());
        let mut seqs = vec![];
        if updates.is_empty() {
            return Ok(seqs);
        }
        let mut tx = state.db.begin().await?;
        for update in &updates {
            self.seq += 1;
            sqlx::query("insert into doc_updates (doc_id, seq, author_uuid, origin, update) values ($1, $2, $3, $4, $5)")
                .bind(doc_id)
                .bind(self.seq)
                .bind(author)
                .bind(origin.as_str())
                .bind(update)
                .execute(&mut *tx)
                .await?;
            seqs.push(self.seq);
        }
        sqlx::query("update docs set seq = $2, updated_at = now() where id = $1")
            .bind(doc_id)
            .bind(self.seq)
            .execute(&mut *tx)
            .await?;
        if self.seq - self.last_checkpoint >= CHECKPOINT_EVERY {
            sqlx::query("insert into doc_checkpoints (doc_id, seq, state) values ($1, $2, $3) on conflict do nothing")
                .bind(doc_id)
                .bind(self.seq)
                .bind(self.full_state())
                .execute(&mut *tx)
                .await?;
            self.last_checkpoint = self.seq;
        }
        tx.commit().await?;
        for update in &updates {
            let bytes = encode(&Message::Sync(SyncMessage::Update(update.clone())));
            // An offline editor with GC disabled can send text it already deleted. Its history
            // belongs in storage, but readers must not receive that text in the live broadcast.
            let reader_bytes = if self.conns.values().any(|c| c.role < Role::Editor) {
                let decoded = Update::decode_v1(update).map_err(ApiError::internal)?;
                let inserted = decoded.insertions(true);
                if inserted.diff(decoded.delete_set()) != inserted {
                    let clean = write_doc::history::without_history(&self.full_state())
                        .map_err(ApiError::internal)?;
                    let mut before = self.ydoc.transact().state_vector();
                    for (client, clock) in decoded.state_vector_lower().iter() {
                        before.set_min(*client, *clock);
                    }
                    Some(encode(&Message::Sync(SyncMessage::Update(
                        clean.transact().encode_state_as_update_v1(&before),
                    ))))
                } else {
                    None
                }
            } else {
                None
            };
            for (id, conn) in &self.conns {
                if Some(*id) != skip_conn {
                    let payload = if conn.role < Role::Editor {
                        reader_bytes.as_ref().unwrap_or(&bytes)
                    } else {
                        &bytes
                    };
                    let _ = conn.tx.send(WsMessage::Binary(payload.clone().into()));
                }
            }
        }
        self.last_used = Instant::now();
        self.index_due = Some(Instant::now() + Duration::from_millis(1500));
        Ok(seqs)
    }

    async fn claim_client(
        &mut self,
        state: &AppState,
        doc_id: &str,
        client: u64,
        author: &str,
    ) -> ApiResult<bool> {
        match self.clients.get(&client) {
            Some(owner) => Ok(owner == author),
            None => {
                sqlx::query("insert into doc_clients (doc_id, client_id, author_uuid) values ($1, $2, $3) on conflict do nothing")
                    .bind(doc_id)
                    .bind(client as i64)
                    .bind(author)
                    .execute(&state.db)
                    .await?;
                self.clients.insert(client, author.to_owned());
                Ok(true)
            }
        }
    }

    async fn authors_event(&self, state: &AppState) -> ApiResult<Vec<u8>> {
        let uuids: Vec<String> = self.clients.values().cloned().collect();
        let people = accounts::many(state, &uuids).await?;
        let clients: serde_json::Map<String, Value> = self
            .clients
            .iter()
            .filter_map(|(c, uuid)| {
                people.get(uuid).map(|a| {
                    (
                        c.to_string(),
                        serde_json::to_value(a).unwrap_or(Value::Null),
                    )
                })
            })
            .collect();
        Ok(event_message(
            &json!({ "type": "authors", "clients": clients }),
        ))
    }

    async fn broadcast_authors(&self, state: &AppState) {
        if let Ok(bytes) = self.authors_event(state).await {
            for conn in self.conns.values() {
                let _ = conn.tx.send(WsMessage::Binary(bytes.clone().into()));
            }
        }
    }
}

/// Makes a change as `author`: `f` edits a copy of the doc (made from the live doc, or from the
/// doc as it was at `base_seq`), and what it changed is merged into the live doc.
pub async fn edit<T>(
    state: &AppState,
    doc_id: &str,
    author: &str,
    origin: Origin,
    base_seq: Option<i64>,
    f: impl FnOnce(&yrs::Doc) -> ApiResult<T>,
) -> ApiResult<(T, i64)> {
    edit_expecting(state, doc_id, author, origin, base_seq, None, f).await
}

/// Like [`edit`], but only when the doc is still at `expect_seq` (for changes computed from the
/// history outside the room); otherwise `Err` with code `conflict`, and the caller recomputes.
pub async fn edit_expecting<T>(
    state: &AppState,
    doc_id: &str,
    author: &str,
    origin: Origin,
    base_seq: Option<i64>,
    expect_seq: Option<i64>,
    f: impl FnOnce(&yrs::Doc) -> ApiResult<T>,
) -> ApiResult<(T, i64)> {
    let room = state.rooms.get(state, doc_id).await?;
    let mut inner = room.inner.lock().await;
    inner.editable(expect_seq)?;
    let creating = inner.seq == 0 && matches!(origin, Origin::Import);
    let copy = inner.copy(state, doc_id, base_seq, &[]).await?;
    let result = f(&copy.doc)?;
    if !copy.changed() {
        return Ok((result, inner.seq));
    }
    inner.take(state, doc_id, author, &copy).await?;
    inner.commit(state, doc_id, author, origin, None).await?;
    inner.broadcast_authors(state).await;
    // A brand-new doc has no one in it to see its creator arrive.
    if !creating && !matches!(origin, Origin::Create) {
        inner.visit(state, author, &copy).await;
    }
    let seq = inner.seq;
    drop(inner);
    // Changes made through the API (a Silicon's edit, a restore) are searchable as soon as the call returns.
    if let Err(e) = index(state, &room).await {
        tracing::warn!(doc = %doc_id, error = %e.message, "indexing failed");
    }
    Ok((result, seq))
}

/// What became of a whole new version written with [`write_version`].
pub struct Written {
    pub seq: i64,
    /// Where it met changes made since and couldn't merge cleanly, each with the id of the
    /// suggestion it became (none when the doc already read that way).
    pub conflicts: Vec<(write_doc::merge::Conflict, Option<String>)>,
}

/// A whole new version of the doc (`new`, as read from Markdown) written as `author` from the doc as
/// it was at `base_seq` (`PUT …/markdown`), merged with everything changed since
/// ([`write_doc::merge`], UNDERSTANDING.md "Never overwritten"): the clean part as one change (a
/// suggestion when `mode` says so), then each conflict as `author`'s suggestion on the doc as it
/// is, all under the room's lock so nothing comes in between. `check` sees the doc before and after
/// each change and can refuse it (a commenter may only add suggestions).
pub async fn write_version(
    state: &AppState,
    doc_id: &str,
    author: &str,
    base_seq: Option<i64>,
    new: &write_doc::Doc,
    mode: &ydoc::EditMode,
    check: impl Fn(&write_doc::Doc, &write_doc::Doc) -> ApiResult<()>,
) -> ApiResult<Written> {
    use write_doc::merge;
    let normal = |doc: &write_doc::Doc| write_doc::from_markdown(&write_doc::to_markdown(doc));
    let room = state.rooms.get(state, doc_id).await?;
    let mut inner = room.inner.lock().await;
    inner.editable(None)?;
    // The doc as it is, when it changed since the version the new one was written from.
    let theirs = base_seq
        .filter(|seq| *seq < inner.seq)
        .map(|_| normal(&inner.read()));

    let copy = inner.copy(state, doc_id, base_seq, &[]).await?;
    let before = ydoc::read_doc(&copy.doc);
    let base = normal(&before);
    let plan = match &theirs {
        Some(theirs) => merge::plan(&base, theirs, new),
        None => merge::Plan {
            direct: new.clone(),
            conflicts: vec![],
        },
    };
    ydoc::with_txn(&copy.doc, |txn, frag| {
        ydoc::patch(txn, frag, &base, &plan.direct, mode)
    });
    check(&before, &ydoc::read_doc(&copy.doc))?;
    let mut last: Option<Copy> = None;
    if copy.changed() {
        inner.take(state, doc_id, author, &copy).await?;
        inner
            .commit(
                state,
                doc_id,
                author,
                if mode.suggest.is_some() {
                    Origin::Suggestion
                } else {
                    Origin::Edit
                },
                None,
            )
            .await?;
        last = Some(copy);
    }

    // Each conflict becomes a suggestion, made on its own copy of the doc as it is now.
    let mut conflicts = vec![];
    if let (Some(theirs), false) = (&theirs, plan.conflicts.is_empty()) {
        let now = normal(&inner.read());
        let mut copies: Vec<Copy> = vec![];
        for conflict in plan.conflicts {
            let taken: Vec<u64> = copies.iter().map(|c| c.client).collect();
            let copy = inner.copy(state, doc_id, None, &taken).await?;
            let current = ydoc::read_doc(&copy.doc);
            let id = ids::new_id("s");
            let target = merge::place(theirs, &now, &conflict);
            let suggest = ydoc::EditMode {
                suggest: Some((id.clone(), author.to_owned())),
            };
            ydoc::with_txn(&copy.doc, |txn, frag| {
                ydoc::patch(txn, frag, &now, &target, &suggest)
            });
            check(&current, &ydoc::read_doc(&copy.doc))?;
            let made = copy.changed();
            if made {
                copies.push(copy);
            }
            conflicts.push((conflict, made.then_some(id)));
        }
        for copy in &copies {
            inner.take(state, doc_id, author, copy).await?;
        }
        if !copies.is_empty() {
            inner
                .commit(state, doc_id, author, Origin::Suggestion, None)
                .await?;
        }
        last = copies.pop().or(last);
    }
    let seq = inner.seq;
    let changed = last.is_some();
    if let Some(copy) = &last {
        inner.broadcast_authors(state).await;
        inner.visit(state, author, copy).await;
    }
    drop(inner);
    if changed && let Err(e) = index(state, &room).await {
        tracing::warn!(doc = %doc_id, error = %e.message, "indexing failed");
    }
    Ok(Written { seq, conflicts })
}

/// How long someone who changed the doc through the API stays among the people in it.
const VISIT: Duration = Duration::from_secs(30);

/// Someone shown in the doc after changing it through the API.
struct Visitor {
    /// The awareness client id they show up under here.
    client: u64,
    clock: u32,
    until: Instant,
}

/// The caret colour the web editor gives an account (components/editor/editor.tsx, `colourFor`).
fn colour_for(uuid: &str) -> &'static str {
    const COLOURS: [&str; 7] = [
        "#1f5cb1", "#b5531c", "#2f7a4a", "#8a3fa0", "#a0362f", "#2c6f86", "#7a6a1f",
    ];
    let mut hash: u32 = 0;
    for c in uuid.encode_utf16() {
        hash = hash.wrapping_mul(31).wrapping_add(u32::from(c));
    }
    COLOURS[hash as usize % COLOURS.len()]
}

/// A copy of the doc a change is made on, before what it changed is merged into the live doc.
struct Copy {
    /// The copy's own client id, which becomes the author's.
    client: u64,
    doc: yrs::Doc,
    before: StateVector,
    snapshot: yrs::Snapshot,
}

impl Copy {
    /// Deletions alone don't move the state vector, so this compares whole snapshots.
    fn changed(&self) -> bool {
        self.doc.transact().snapshot() != self.snapshot
    }
}

impl RoomState {
    /// Refuses changes to a doc being reloaded or in the trash, or (with `expect_seq`) one that
    /// changed meanwhile.
    fn editable(&self, expect_seq: Option<i64>) -> ApiResult<()> {
        if self.poisoned {
            return Err(
                ApiError::unavailable("This doc is being reloaded.").hint("Try again in a moment.")
            );
        }
        if self.deleted {
            return Err(ApiError::conflict("This doc is in the trash.").hint("Restore it first."));
        }
        if expect_seq.is_some_and(|seq| seq != self.seq) {
            return Err(ApiError::conflict("The doc changed meanwhile."));
        }
        Ok(())
    }

    /// A copy of the doc as it is (or as it was at `base_seq`), with a client id no one has used
    /// here (nor one in `taken`).
    async fn copy(
        &self,
        state: &AppState,
        doc_id: &str,
        base_seq: Option<i64>,
        taken: &[u64],
    ) -> ApiResult<Copy> {
        let client = loop {
            let candidate = ids::new_client_id();
            if !self.clients.contains_key(&candidate) && !taken.contains(&candidate) {
                break candidate;
            }
        };
        let doc = ydoc::new_ydoc(client);
        let base_state = match base_seq {
            Some(seq) if seq < self.seq => {
                let updates: Vec<Vec<u8>> = sqlx::query_scalar(
                    "select update from doc_updates where doc_id = $1 and seq <= $2 order by seq",
                )
                .bind(doc_id)
                .bind(seq)
                .fetch_all(&state.db)
                .await?;
                let base = write_doc::history::replay(updates.iter().map(|u| u.as_slice()))?;
                base.transact()
                    .encode_state_as_update_v1(&StateVector::default())
            }
            _ => self.full_state(),
        };
        doc.transact_mut()
            .apply_update(Update::decode_v1(&base_state).map_err(ApiError::internal)?)
            .map_err(ApiError::internal)?;
        let (before, snapshot) = {
            let txn = doc.transact();
            (txn.state_vector(), txn.snapshot())
        };
        Ok(Copy {
            client,
            doc,
            before,
            snapshot,
        })
    }

    /// After `author` changed the doc through the API (a Silicon at the command line), shows them
    /// among the people in the doc for a while, like anyone typing in it (UNDERSTANDING.md:
    /// "Silicons show up exactly like Carbons do"), with their cursor just after the last thing the
    /// change put in. Not for someone who has the doc open: they are there already.
    async fn visit(&mut self, state: &AppState, author: &str, copy: &Copy) {
        if self
            .conns
            .values()
            .any(|c| c.account.as_ref().is_some_and(|a| a.uuid == author))
        {
            return;
        }
        let Ok(account) = accounts::one(state, author).await else {
            return;
        };
        // The last thing the change inserted, if anything: the cursor goes right after it.
        let changed = copy.doc.transact().encode_diff_v1(&copy.before);
        let last = Update::decode_v1(&changed)
            .ok()
            .and_then(|update| {
                write_doc::history::inserted_upper(&update)
                    .into_iter()
                    .find(|(client, _)| *client == copy.client)
            })
            .map(|(client, end)| (client, end - 1))
            .or_else(|| {
                let deleted = copy
                    .doc
                    .transact()
                    .snapshot()
                    .delete_set
                    .diff(&copy.snapshot.delete_set);
                deleted.iter().find_map(|(client, ranges)| {
                    ranges.iter().next().map(|r| (client.get(), r.start))
                })
            });
        let taken: HashSet<u64> = self
            .awareness
            .keys()
            .copied()
            .chain(self.clients.keys().copied())
            .collect();
        let visitor = self
            .visitors
            .entry(author.to_owned())
            .or_insert_with(|| Visitor {
                client: loop {
                    let candidate = ids::new_client_id();
                    if !taken.contains(&candidate) {
                        break candidate;
                    }
                },
                clock: 0,
                until: Instant::now(),
            });
        visitor.clock += 1;
        visitor.until = Instant::now() + VISIT;
        let name = if account.display_name.is_empty() {
            account.id.clone()
        } else {
            account.display_name.clone()
        };
        let mut presence = json!({
            "user": { "uuid": account.uuid, "id": account.id, "name": name, "kind": account.kind, "pfp_url": account.pfp_url, "color": colour_for(&account.uuid) },
        });
        if let Some((client, clock)) = last {
            let at = json!({ "item": { "client": client, "clock": clock }, "assoc": -1 });
            presence["cursor"] = json!({ "anchor": at, "head": at });
        }
        let (client, clock, presence) = (visitor.client, visitor.clock, presence.to_string());
        self.awareness.insert(client, (clock, presence.clone()));
        self.send_awareness(client, clock, &presence);
    }

    /// Visitors whose time is up leave the doc.
    fn end_visits(&mut self) {
        let now = Instant::now();
        let ended: Vec<String> = self
            .visitors
            .iter()
            .filter(|(_, v)| v.until <= now)
            .map(|(author, _)| author.clone())
            .collect();
        for author in ended {
            self.end_visit(&author);
        }
    }

    fn end_visit(&mut self, author: &str) {
        if let Some(visitor) = self.visitors.remove(author) {
            self.awareness.remove(&visitor.client);
            self.send_awareness(visitor.client, visitor.clock + 1, "null");
        }
    }

    fn send_awareness(&self, client: u64, clock: u32, json: &str) {
        let update = AwarenessUpdate {
            clients: HashMap::from([(
                yrs::ClientID::new(client),
                AwarenessUpdateEntry {
                    clock,
                    json: Arc::from(json),
                },
            )]),
        };
        let bytes = encode(&Message::Awareness(update));
        for conn in self.conns.values() {
            let _ = conn.tx.send(WsMessage::Binary(bytes.clone().into()));
        }
    }

    /// Merges what a copy changed into the live doc, as `author`'s (call [`RoomState::commit`] after).
    async fn take(
        &mut self,
        state: &AppState,
        doc_id: &str,
        author: &str,
        copy: &Copy,
    ) -> ApiResult<()> {
        self.claim_client(state, doc_id, copy.client, author)
            .await?;
        let changed = copy.doc.transact().encode_diff_v1(&copy.before);
        let update = Update::decode_v1(&changed).map_err(ApiError::internal)?;
        self.ydoc
            .transact_mut()
            .apply_update(update)
            .map_err(ApiError::internal)?;
        Ok(())
    }
}

/// Reads the live doc.
pub async fn read(state: &AppState, doc_id: &str) -> ApiResult<(write_doc::Doc, i64)> {
    let room = state.rooms.get(state, doc_id).await?;
    let inner = room.inner.lock().await;
    Ok((inner.read(), inner.seq))
}

/// Runs `f` with the live Yjs doc (read only).
pub async fn with_ydoc<T>(
    state: &AppState,
    doc_id: &str,
    f: impl FnOnce(&yrs::Doc, i64) -> T,
) -> ApiResult<T> {
    let room = state.rooms.get(state, doc_id).await?;
    let inner = room.inner.lock().await;
    Ok(f(&inner.ydoc, inner.seq))
}

/// Updates the doc's search text, links and suggestions after it changed.
async fn index(state: &AppState, room: &Arc<Room>) -> ApiResult<()> {
    let (doc, seq) = {
        let mut inner = room.inner.lock().await;
        inner.index_due = None;
        (inner.read(), inner.seq)
    };
    // Postgres text can't hold NUL: it never reaches the index.
    let plain = doc.without_suggestions().plain_text().replace('\0', "");
    let links: Vec<String> = doc
        .doc_links()
        .iter()
        .map(|l| l.replace('\0', "").trim().to_lowercase())
        .collect();
    // The uploaded images the doc shows: anyone who can open it can see them. Never forgotten, so an
    // older version still shows its images.
    let images: Vec<String> = write_doc::pandoc::images(&doc)
        .iter()
        .filter_map(|src| crate::content::asset_id_from_src(state, src))
        .collect();
    if !images.is_empty() {
        sqlx::query("insert into doc_assets (doc_id, asset_id) select $1, id from assets where id = any($2) on conflict do nothing")
            .bind(&room.doc_id)
            .bind(&images)
            .execute(&state.db)
            .await?;
    }
    sqlx::query(
        "update docs set plain_text = $2, links = $3,
            search = setweight(to_tsvector('simple', coalesce(title, '')), 'A') || setweight(to_tsvector('simple', $2), 'B')
         where id = $1",
    )
    .bind(&room.doc_id)
    .bind(&plain)
    .bind(&links)
    .execute(&state.db)
    .await?;
    // New suggestions are announced to the doc's owner.
    for suggestion in doc.suggestions() {
        let inserted: Option<String> = sqlx::query_scalar(
            "insert into suggestions (doc_id, id, author_uuid) values ($1, $2, $3) on conflict do nothing returning id",
        )
        .bind(&room.doc_id)
        .bind(&suggestion.id)
        .bind(&suggestion.author)
        .fetch_optional(&state.db)
        .await?;
        if inserted.is_some() {
            crate::notify::suggestion_created(state, &room.doc_id, &suggestion, seq).await?;
        }
    }
    Ok(())
}

// ------------------------------------------------------------------------------------------
// Connections
// ------------------------------------------------------------------------------------------

pub async fn serve(
    state: AppState,
    doc_id: String,
    account: Option<Account>,
    role: Role,
    socket: WebSocket,
) {
    let room = match state.rooms.get(&state, &doc_id).await {
        Ok(room) => room,
        Err(_) => return,
    };
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<WsMessage>();
    let conn_id = ids::new_client_id();
    {
        let mut inner = room.inner.lock().await;
        // Someone shown here after an API change who now opens the doc is here for real.
        if let Some(account) = &account {
            inner.end_visit(&account.uuid);
        }
        // Hello: start syncing, then who wrote what, then who's here.
        let sv = inner.ydoc.transact().state_vector();
        let _ = tx.send(WsMessage::Binary(
            encode(&Message::Sync(SyncMessage::SyncStep1(sv))).into(),
        ));
        if let Ok(bytes) = inner.authors_event(&state).await {
            let _ = tx.send(WsMessage::Binary(bytes.into()));
        }
        let _ = tx.send(WsMessage::Binary(
            event_message(&json!({ "type": "hello", "role": role.as_str(), "account": account, "seq": inner.seq })).into(),
        ));
        if !inner.awareness.is_empty() {
            let update = AwarenessUpdate {
                clients: inner
                    .awareness
                    .iter()
                    .map(|(c, (clock, json))| {
                        (
                            yrs::ClientID::new(*c),
                            AwarenessUpdateEntry {
                                clock: *clock,
                                json: Arc::from(json.as_str()),
                            },
                        )
                    })
                    .collect(),
            };
            let _ = tx.send(WsMessage::Binary(
                encode(&Message::Awareness(update)).into(),
            ));
        }
        inner.conns.insert(
            conn_id,
            Conn {
                tx: tx.clone(),
                account: account.clone(),
                role,
                awareness: HashSet::new(),
            },
        );
        inner.last_used = Instant::now();
    }

    let writer = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            let closing = matches!(message, WsMessage::Close(_));
            if sink.send(message).await.is_err() || closing {
                break;
            }
        }
    });

    while let Some(Ok(message)) = stream.next().await {
        match message {
            WsMessage::Binary(bytes) => {
                if let Err(e) = handle(&state, &room, conn_id, &bytes).await {
                    tracing::warn!(doc = %doc_id, error = %e.message, "live message refused");
                    let _ = tx.send(WsMessage::Binary(
                        event_message(&json!({ "type": "rejected", "reason": e.message })).into(),
                    ));
                }
            }
            WsMessage::Close(_) => break,
            _ => {}
        }
    }

    // Gone: tell the others its cursors left.
    {
        let mut inner = room.inner.lock().await;
        inner.remove_connection(conn_id);
        inner.last_used = Instant::now();
    }
    writer.abort();
}

async fn handle(state: &AppState, room: &Arc<Room>, conn_id: u64, bytes: &[u8]) -> ApiResult<()> {
    let mut decoder = DecoderV1::new(Cursor::new(bytes));
    let messages: Vec<Message> = MessageReader::new(&mut decoder)
        .filter_map(Result::ok)
        .collect();
    for message in messages {
        match message {
            Message::Sync(SyncMessage::SyncStep1(sv)) => {
                let inner = room.inner.lock().await;
                // The history (the text of everything deleted) is for editors, like versions: anyone else
                // syncs from a copy without it.
                let reader = inner
                    .conns
                    .get(&conn_id)
                    .is_some_and(|c| c.role < Role::Editor);
                let update = if reader {
                    match write_doc::history::without_history(&inner.full_state()) {
                        Ok(doc) => doc.transact().encode_state_as_update_v1(&sv),
                        Err(e) => {
                            tracing::warn!(doc = %room.doc_id, error = %e, "couldn't make a copy without the history");
                            continue;
                        }
                    }
                } else {
                    inner.ydoc.transact().encode_state_as_update_v1(&sv)
                };
                if let Some(conn) = inner.conns.get(&conn_id) {
                    let _ = conn.tx.send(WsMessage::Binary(
                        encode(&Message::Sync(SyncMessage::SyncStep2(update))).into(),
                    ));
                }
            }
            Message::Sync(SyncMessage::SyncStep2(update))
            | Message::Sync(SyncMessage::Update(update)) => {
                apply_client_update(state, room, conn_id, &update).await?;
            }
            Message::Awareness(update) => awareness(room, conn_id, update).await,
            Message::AwarenessQuery => {
                let inner = room.inner.lock().await;
                let update = AwarenessUpdate {
                    clients: inner
                        .awareness
                        .iter()
                        .map(|(c, (clock, json))| {
                            (
                                yrs::ClientID::new(*c),
                                AwarenessUpdateEntry {
                                    clock: *clock,
                                    json: Arc::from(json.as_str()),
                                },
                            )
                        })
                        .collect(),
                };
                if let Some(conn) = inner.conns.get(&conn_id) {
                    let _ = conn.tx.send(WsMessage::Binary(
                        encode(&Message::Awareness(update)).into(),
                    ));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// Presence: the `user` of every awareness state is set to the connection's real account, so
/// nobody can show up under someone else's name.
async fn awareness(room: &Arc<Room>, conn_id: u64, update: AwarenessUpdate) {
    let mut inner = room.inner.lock().await;
    let Some(conn) = inner.conns.get(&conn_id) else {
        return;
    };
    let identity = conn.account.clone();
    let mut clients = HashMap::new();
    let mut announced = vec![];
    for (client, entry) in update.clients {
        let client_id = client.get();
        // Providers relay awareness they receive. Only the connection that first announced a
        // live presence may change it; relayed states never become the relay's own cursors.
        if inner.visitors.values().any(|v| v.client == client_id)
            || inner
                .conns
                .iter()
                .any(|(id, c)| *id != conn_id && c.awareness.contains(&client_id))
            || inner
                .clients
                .get(&client_id)
                .is_some_and(|owner| identity.as_ref().is_none_or(|a| a.uuid != *owner))
        {
            continue;
        }
        if inner
            .awareness
            .get(&client_id)
            .is_some_and(|(clock, _)| *clock >= entry.clock)
        {
            continue;
        }
        if entry.json.as_ref() == "null"
            && !inner
                .conns
                .get(&conn_id)
                .is_some_and(|c| c.awareness.contains(&client_id))
        {
            continue;
        }
        let json = if entry.json.as_ref() == "null" {
            "null".to_owned()
        } else {
            let mut value: Value = serde_json::from_str(&entry.json).unwrap_or(json!({}));
            if let Some(map) = value.as_object_mut() {
                let color = map
                    .get("user")
                    .and_then(|u| u.get("color"))
                    .cloned()
                    .unwrap_or(json!("#1f5cb1"));
                let user = match &identity {
                    Some(a) => {
                        json!({ "uuid": a.uuid, "id": a.id, "name": if a.display_name.is_empty() { a.id.clone() } else { a.display_name.clone() }, "kind": a.kind, "pfp_url": a.pfp_url, "color": color })
                    }
                    None => {
                        json!({ "id": "", "name": "Someone with the link", "kind": "carbon", "color": color })
                    }
                };
                map.insert("user".into(), user);
            }
            value.to_string()
        };
        if json == "null" {
            inner.awareness.remove(&client_id);
        } else {
            inner
                .awareness
                .insert(client_id, (entry.clock, json.clone()));
            announced.push(client_id);
        }
        clients.insert(
            client,
            AwarenessUpdateEntry {
                clock: entry.clock,
                json: Arc::from(json.as_str()),
            },
        );
    }
    if let Some(conn) = inner.conns.get_mut(&conn_id) {
        conn.awareness.extend(announced);
    }
    if clients.is_empty() {
        return;
    }
    let bytes = encode(&Message::Awareness(AwarenessUpdate { clients }));
    for (id, other) in &inner.conns {
        if *id != conn_id {
            let _ = other.tx.send(WsMessage::Binary(bytes.clone().into()));
        }
    }
}

async fn apply_client_update(
    state: &AppState,
    room: &Arc<Room>,
    conn_id: u64,
    bytes: &[u8],
) -> ApiResult<()> {
    let mut inner = room.inner.lock().await;
    if inner.poisoned {
        return Err(ApiError::unavailable("This doc is being reloaded."));
    }
    let (role, account) = match inner.conns.get(&conn_id) {
        Some(c) => (c.role, c.account.clone()),
        None => return Ok(()),
    };
    let update =
        Update::decode_v1(bytes).map_err(|_| ApiError::invalid("That change couldn't be read."))?;
    let snapshot = inner.ydoc.transact().snapshot();
    let known = &snapshot.state_map;
    let new_clients: Vec<u64> = write_doc::history::inserted_upper(&update)
        .into_iter()
        .filter(|(client, end)| *end > known.get(&yrs::ClientID::new(*client)))
        .map(|(client, _)| client)
        .collect();
    let deletes = !update.delete_set().diff(&snapshot.delete_set).is_empty();
    if new_clients.is_empty() && !deletes {
        return Ok(());
    }
    let Some(account) = account else {
        return Err(ApiError::forbidden("Sign in to change this doc."));
    };
    if role < Role::Commenter || inner.deleted {
        return Err(ApiError::forbidden("You can't change this doc."));
    }
    for client in &new_clients {
        let owner = inner.clients.get(client);
        if owner.is_some_and(|o| *o != account.uuid) {
            return Err(ApiError::forbidden(
                "That change claims to come from someone else.",
            ));
        }
    }
    // Reject clock gaps before Yrs can integrate a Skip which Yjs cannot replay. Missing
    // dependencies are refused on a scratch document, never left pending in the live room.
    for (client, ranges) in update.insertions(true).iter() {
        let mut next = known.get(client);
        for range in ranges.iter() {
            if range.start > next {
                return Err(ApiError::conflict(
                    "An earlier change is missing. Reconnect to sync your changes first.",
                ));
            }
            next = next.max(range.end);
        }
    }
    let before = inner.read();
    let copy = ydoc::new_ydoc(1);
    copy.transact_mut()
        .apply_update(Update::decode_v1(&inner.full_state()).map_err(ApiError::internal)?)
        .map_err(ApiError::internal)?;
    copy.transact_mut()
        .apply_update(Update::decode_v1(bytes).map_err(ApiError::internal)?)
        .map_err(ApiError::internal)?;
    if copy.transact().has_missing_updates() {
        return Err(ApiError::conflict(
            "An earlier change is missing. Reconnect to sync your changes first.",
        ));
    }
    validation::validate(&copy)?;
    if validation::new_code_marks(&inner.ydoc, &copy) {
        return Err(ApiError::invalid(
            "Code suggestions must be made on the code block.",
        ));
    }
    let after = ydoc::read_doc(&copy);
    if role == Role::Commenter
        && (!suggestion_only(&before, &after, &account.uuid)
            || validation::unmodeled_changes(&inner.ydoc, &copy, &account.uuid))
    {
        return Err(ApiError::forbidden("Commenters can only suggest changes.")
            .hint("Switch to suggesting."));
    }
    if suggests_for_someone_else(&before, &after, &account.uuid)
        || validation::foreign_suggestions(&inner.ydoc, &copy, &account.uuid)
    {
        return Err(ApiError::forbidden(
            "A suggestion can only be made in your own name.",
        ));
    }
    let mut claimed = false;
    for client in new_clients {
        if !inner.clients.contains_key(&client) {
            claimed = true;
        }
        inner
            .claim_client(state, &room.doc_id, client, &account.uuid)
            .await?;
    }
    // Receivers need the account map before the first update from a new live writer, so its
    // insertion highlight is attributed from the moment it appears.
    if claimed {
        inner.broadcast_authors(state).await;
    }
    inner
        .ydoc
        .transact_mut()
        .apply_update(update)
        .map_err(ApiError::internal)?;
    inner
        .commit(
            state,
            &room.doc_id,
            &account.uuid,
            Origin::Live,
            Some(conn_id),
        )
        .await?;
    Ok(())
}

/// Whether `after` has a new suggestion that names someone other than `author` as its author.
/// (Typing inside someone's pending suggestion adds to theirs, which is fine.)
pub fn suggests_for_someone_else(
    before: &write_doc::Doc,
    after: &write_doc::Doc,
    author: &str,
) -> bool {
    let known: std::collections::HashSet<(String, String)> = before
        .suggestions()
        .into_iter()
        .map(|s| (s.id, s.author))
        .collect();
    after
        .suggestions()
        .into_iter()
        .any(|s| s.author != author && !known.contains(&(s.id, s.author)))
}

/// Whether `after` differs from `before` only by `author`'s own suggestions.
pub fn suggestion_only(before: &write_doc::Doc, after: &write_doc::Doc, author: &str) -> bool {
    if before.without_suggestions() != after.without_suggestions() {
        return false;
    }
    let others = |doc: &write_doc::Doc| -> Vec<write_doc::SuggestionSummary> {
        doc.suggestions()
            .into_iter()
            .filter(|s| s.author != author)
            .collect()
    };
    others(before) == others(after)
}
