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

use axum::extract::ws::{Message as WsMessage, WebSocket};
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

#[derive(Default)]
pub struct Rooms {
    map: Mutex<HashMap<String, Arc<Room>>>,
}

pub struct Room {
    pub doc_id: String,
    pub inner: Mutex<RoomState>,
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
    last_used: Instant,
    pub deleted: bool,
    index_due: Option<Instant>,
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
    encode(&Message::Custom(MSG_EVENT, serde_json::to_vec(value).unwrap_or_default()))
}

impl Rooms {
    /// The room for a doc, loading it from storage when nobody has it open.
    pub async fn get(&self, state: &AppState, doc_id: &str) -> ApiResult<Arc<Room>> {
        let mut map = self.map.lock().await;
        if let Some(room) = map.get(doc_id) {
            return Ok(room.clone());
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
        let Ok(doc) = crate::access::load_doc(state, doc_id).await else { return };
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
                        let _ = conn.tx.send(WsMessage::Binary(event_message(&json!({ "type": "role", "role": role.as_str() })).into()));
                    }
                }
                _ => {
                    let _ = conn.tx.send(WsMessage::Binary(event_message(&json!({ "type": "role", "role": null })).into()));
                    let _ = conn.tx.send(WsMessage::Close(None));
                    closed.push(*id);
                }
            }
        }
        for id in closed {
            inner.conns.remove(&id);
        }
    }

    /// Drops rooms nobody has had open for a while, and indexes changed docs.
    pub async fn maintain(&self, state: &AppState) {
        let rooms: Vec<Arc<Room>> = self.map.lock().await.values().cloned().collect();
        for room in &rooms {
            let due = {
                let inner = room.inner.lock().await;
                inner.index_due.is_some_and(|t| t <= Instant::now())
            };
            if due {
                if let Err(e) = index(state, room).await {
                    tracing::warn!(doc = %room.doc_id, error = %e.message, "indexing failed");
                }
            }
        }
        let mut map = self.map.lock().await;
        let mut idle = vec![];
        for (id, room) in map.iter() {
            if let Ok(inner) = room.inner.try_lock() {
                if inner.conns.is_empty() && inner.index_due.is_none() && inner.last_used.elapsed() > Duration::from_secs(600) {
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
                let _ = conn.tx.send(WsMessage::Close(None));
            }
        }
    }
}

async fn load(state: &AppState, doc_id: &str) -> ApiResult<Room> {
    let doc = crate::access::load_doc(state, doc_id).await?;
    let ydoc = ydoc::new_ydoc(1);
    let checkpoint: Option<(i64, Vec<u8>)> = sqlx::query_as("select seq, state from doc_checkpoints where doc_id = $1 order by seq desc limit 1")
        .bind(doc_id)
        .fetch_optional(&state.db)
        .await?;
    let from = checkpoint.as_ref().map(|c| c.0).unwrap_or(0);
    let updates: Vec<(i64, Vec<u8>)> = sqlx::query_as("select seq, update from doc_updates where doc_id = $1 and seq > $2 order by seq")
        .bind(doc_id)
        .bind(from)
        .fetch_all(&state.db)
        .await?;
    {
        let mut txn = ydoc.transact_mut();
        if let Some((_, bytes)) = &checkpoint {
            txn.apply_update(Update::decode_v1(bytes).map_err(ApiError::internal)?).map_err(ApiError::internal)?;
        }
        for (_, bytes) in &updates {
            txn.apply_update(Update::decode_v1(bytes).map_err(ApiError::internal)?).map_err(ApiError::internal)?;
        }
    }
    let seq = updates.last().map(|u| u.0).unwrap_or(from).max(doc.seq);
    let clients: Vec<(i64, String)> = sqlx::query_as("select client_id, author_uuid from doc_clients where doc_id = $1")
        .bind(doc_id)
        .fetch_all(&state.db)
        .await?;
    let captured = Arc::new(std::sync::Mutex::new(vec![]));
    let sink = captured.clone();
    ydoc.observe_update_v1("store", move |_: &yrs::TransactionMut, e: &yrs::UpdateEvent| {
        sink.lock().unwrap().push(e.update.clone());
    })
    .map_err(ApiError::internal)?;
    Ok(Room {
        doc_id: doc_id.to_owned(),
        inner: Mutex::new(RoomState {
            ydoc,
            captured,
            seq,
            last_checkpoint: from,
            clients: clients.into_iter().map(|(c, a)| (c as u64, a)).collect(),
            conns: HashMap::new(),
            awareness: HashMap::new(),
            last_used: Instant::now(),
            deleted: doc.deleted_at.is_some(),
            index_due: None,
        }),
    })
}

impl RoomState {
    pub fn read(&self) -> write_doc::Doc {
        ydoc::read_doc(&self.ydoc)
    }

    fn full_state(&self) -> Vec<u8> {
        self.ydoc.transact().encode_state_as_update_v1(&StateVector::default())
    }

    /// Stores what the last transactions changed and sends it to everyone else.
    async fn commit(&mut self, state: &AppState, doc_id: &str, author: &str, origin: Origin, skip_conn: Option<u64>) -> ApiResult<Vec<i64>> {
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
        sqlx::query("update docs set seq = $2, updated_at = now() where id = $1").bind(doc_id).bind(self.seq).execute(&mut *tx).await?;
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
            for (id, conn) in &self.conns {
                if Some(*id) != skip_conn {
                    let _ = conn.tx.send(WsMessage::Binary(bytes.clone().into()));
                }
            }
        }
        self.last_used = Instant::now();
        self.index_due = Some(Instant::now() + Duration::from_millis(1500));
        Ok(seqs)
    }

    async fn claim_client(&mut self, state: &AppState, doc_id: &str, client: u64, author: &str) -> ApiResult<bool> {
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
            .filter_map(|(c, uuid)| people.get(uuid).map(|a| (c.to_string(), serde_json::to_value(a).unwrap_or(Value::Null))))
            .collect();
        Ok(event_message(&json!({ "type": "authors", "clients": clients })))
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
    if inner.deleted {
        return Err(ApiError::conflict("This doc is in the trash.").hint("Restore it first."));
    }
    if expect_seq.is_some_and(|seq| seq != inner.seq) {
        return Err(ApiError::conflict("The doc changed meanwhile."));
    }
    let client = loop {
        let candidate = ids::new_client_id();
        if !inner.clients.contains_key(&candidate) {
            break candidate;
        }
    };
    let copy = ydoc::new_ydoc(client);
    let base_state = match base_seq {
        Some(seq) if seq < inner.seq => {
            let updates: Vec<Vec<u8>> = sqlx::query_scalar("select update from doc_updates where doc_id = $1 and seq <= $2 order by seq")
                .bind(doc_id)
                .bind(seq)
                .fetch_all(&state.db)
                .await?;
            let base = write_doc::history::replay(updates.iter().map(|u| u.as_slice()))?;
            base.transact().encode_state_as_update_v1(&StateVector::default())
        }
        _ => inner.full_state(),
    };
    copy.transact_mut().apply_update(Update::decode_v1(&base_state).map_err(ApiError::internal)?).map_err(ApiError::internal)?;
    let before = copy.transact().state_vector();
    let before_snapshot = copy.transact().snapshot();
    let result = f(&copy)?;
    let changed = copy.transact().encode_diff_v1(&before);
    // Deletions alone don't move the state vector, so compare whole snapshots.
    let has_changes = copy.transact().snapshot() != before_snapshot;
    if !has_changes {
        return Ok((result, inner.seq));
    }
    inner.claim_client(state, doc_id, client, author).await?;
    {
        let update = Update::decode_v1(&changed).map_err(ApiError::internal)?;
        inner.ydoc.transact_mut().apply_update(update).map_err(ApiError::internal)?;
    }
    inner.commit(state, doc_id, author, origin, None).await?;
    inner.broadcast_authors(state).await;
    let seq = inner.seq;
    Ok((result, seq))
}

/// Reads the live doc.
pub async fn read(state: &AppState, doc_id: &str) -> ApiResult<(write_doc::Doc, i64)> {
    let room = state.rooms.get(state, doc_id).await?;
    let inner = room.inner.lock().await;
    Ok((inner.read(), inner.seq))
}

/// Runs `f` with the live Yjs doc (read only).
pub async fn with_ydoc<T>(state: &AppState, doc_id: &str, f: impl FnOnce(&yrs::Doc, i64) -> T) -> ApiResult<T> {
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
    let plain = doc.without_suggestions().plain_text();
    let links: Vec<String> = doc.doc_links().iter().map(|l| l.trim().to_lowercase()).collect();
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

pub async fn serve(state: AppState, doc_id: String, account: Option<Account>, role: Role, socket: WebSocket) {
    let room = match state.rooms.get(&state, &doc_id).await {
        Ok(room) => room,
        Err(_) => return,
    };
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<WsMessage>();
    let conn_id = ids::new_client_id();
    {
        let mut inner = room.inner.lock().await;
        // Hello: start syncing, then who wrote what, then who's here.
        let sv = inner.ydoc.transact().state_vector();
        let _ = tx.send(WsMessage::Binary(encode(&Message::Sync(SyncMessage::SyncStep1(sv))).into()));
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
                    .map(|(c, (clock, json))| (yrs::ClientID::new(*c), AwarenessUpdateEntry { clock: *clock, json: Arc::from(json.as_str()) }))
                    .collect(),
            };
            let _ = tx.send(WsMessage::Binary(encode(&Message::Awareness(update)).into()));
        }
        inner.conns.insert(conn_id, Conn { tx: tx.clone(), account: account.clone(), role, awareness: HashSet::new() });
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
                    let _ = tx.send(WsMessage::Binary(event_message(&json!({ "type": "rejected", "reason": e.message })).into()));
                }
            }
            WsMessage::Close(_) => break,
            _ => {}
        }
    }

    // Gone: tell the others its cursors left.
    {
        let mut inner = room.inner.lock().await;
        if let Some(conn) = inner.conns.remove(&conn_id) {
            let mut removed = HashMap::new();
            for client in conn.awareness {
                if let Some((clock, _)) = inner.awareness.remove(&client) {
                    removed.insert(yrs::ClientID::new(client), AwarenessUpdateEntry { clock: clock + 1, json: Arc::from("null") });
                }
            }
            if !removed.is_empty() {
                let bytes = encode(&Message::Awareness(AwarenessUpdate { clients: removed }));
                for other in inner.conns.values() {
                    let _ = other.tx.send(WsMessage::Binary(bytes.clone().into()));
                }
            }
        }
        inner.last_used = Instant::now();
    }
    writer.abort();
}

async fn handle(state: &AppState, room: &Arc<Room>, conn_id: u64, bytes: &[u8]) -> ApiResult<()> {
    let mut decoder = DecoderV1::new(Cursor::new(bytes));
    let messages: Vec<Message> = MessageReader::new(&mut decoder).filter_map(Result::ok).collect();
    for message in messages {
        match message {
            Message::Sync(SyncMessage::SyncStep1(sv)) => {
                let inner = room.inner.lock().await;
                let update = inner.ydoc.transact().encode_state_as_update_v1(&sv);
                if let Some(conn) = inner.conns.get(&conn_id) {
                    let _ = conn.tx.send(WsMessage::Binary(encode(&Message::Sync(SyncMessage::SyncStep2(update))).into()));
                }
            }
            Message::Sync(SyncMessage::SyncStep2(update)) | Message::Sync(SyncMessage::Update(update)) => {
                apply_client_update(state, room, conn_id, &update).await?;
            }
            Message::Awareness(update) => awareness(room, conn_id, update).await,
            Message::AwarenessQuery => {
                let inner = room.inner.lock().await;
                let update = AwarenessUpdate {
                    clients: inner
                        .awareness
                        .iter()
                        .map(|(c, (clock, json))| (yrs::ClientID::new(*c), AwarenessUpdateEntry { clock: *clock, json: Arc::from(json.as_str()) }))
                        .collect(),
                };
                if let Some(conn) = inner.conns.get(&conn_id) {
                    let _ = conn.tx.send(WsMessage::Binary(encode(&Message::Awareness(update)).into()));
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
    let Some(conn) = inner.conns.get(&conn_id) else { return };
    let identity = conn.account.clone();
    let mut clients = HashMap::new();
    let mut announced = vec![];
    for (client, entry) in update.clients {
        let client_id = client.get();
        let json = if entry.json.as_ref() == "null" {
            "null".to_owned()
        } else {
            let mut value: Value = serde_json::from_str(&entry.json).unwrap_or(json!({}));
            if let Some(map) = value.as_object_mut() {
                let color = map.get("user").and_then(|u| u.get("color")).cloned().unwrap_or(json!("#1f5cb1"));
                let user = match &identity {
                    Some(a) => json!({ "uuid": a.uuid, "id": a.id, "name": if a.display_name.is_empty() { a.id.clone() } else { a.display_name.clone() }, "kind": a.kind, "pfp_url": a.pfp_url, "color": color }),
                    None => json!({ "id": "", "name": "Someone with the link", "kind": "carbon", "color": color }),
                };
                map.insert("user".into(), user);
            }
            value.to_string()
        };
        if json == "null" {
            inner.awareness.remove(&client_id);
        } else {
            inner.awareness.insert(client_id, (entry.clock, json.clone()));
            announced.push(client_id);
        }
        clients.insert(client, AwarenessUpdateEntry { clock: entry.clock, json: Arc::from(json.as_str()) });
    }
    if let Some(conn) = inner.conns.get_mut(&conn_id) {
        conn.awareness.extend(announced);
    }
    let bytes = encode(&Message::Awareness(AwarenessUpdate { clients }));
    for (id, other) in &inner.conns {
        if *id != conn_id {
            let _ = other.tx.send(WsMessage::Binary(bytes.clone().into()));
        }
    }
}

async fn apply_client_update(state: &AppState, room: &Arc<Room>, conn_id: u64, bytes: &[u8]) -> ApiResult<()> {
    let mut inner = room.inner.lock().await;
    let (role, account) = match inner.conns.get(&conn_id) {
        Some(c) => (c.role, c.account.clone()),
        None => return Ok(()),
    };
    let update = Update::decode_v1(bytes).map_err(|_| ApiError::invalid("That change couldn't be read."))?;
    let known = inner.ydoc.transact().state_vector();
    let new_clients: Vec<u64> = update
        .state_vector()
        .iter()
        .filter(|(client, clock)| **clock > known.get(client))
        .map(|(client, _)| client.get())
        .collect();
    let deletes = !update.delete_set().is_empty();
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
            return Err(ApiError::forbidden("That change claims to come from someone else."));
        }
    }
    if role == Role::Commenter {
        // Commenters can only suggest: check the change on a copy first.
        let before = inner.read();
        let copy = ydoc::new_ydoc(1);
        copy.transact_mut().apply_update(Update::decode_v1(&inner.full_state()).map_err(ApiError::internal)?).map_err(ApiError::internal)?;
        copy.transact_mut().apply_update(Update::decode_v1(bytes).map_err(ApiError::internal)?).map_err(ApiError::internal)?;
        let after = ydoc::read_doc(&copy);
        if !suggestion_only(&before, &after, &account.uuid) {
            return Err(ApiError::forbidden("Commenters can only suggest changes.").hint("Switch to suggesting."));
        }
    }
    let mut claimed = false;
    for client in new_clients {
        if !inner.clients.contains_key(&client) {
            claimed = true;
        }
        inner.claim_client(state, &room.doc_id, client, &account.uuid).await?;
    }
    inner.ydoc.transact_mut().apply_update(update).map_err(ApiError::internal)?;
    inner.commit(state, &room.doc_id, &account.uuid, Origin::Live, Some(conn_id)).await?;
    if claimed {
        inner.broadcast_authors(state).await;
    }
    Ok(())
}

/// Whether `after` differs from `before` only by `author`'s own suggestions.
pub fn suggestion_only(before: &write_doc::Doc, after: &write_doc::Doc, author: &str) -> bool {
    if before.without_suggestions() != after.without_suggestions() {
        return false;
    }
    let others = |doc: &write_doc::Doc| -> Vec<write_doc::SuggestionSummary> {
        doc.suggestions().into_iter().filter(|s| s.author != author).collect()
    };
    others(before) == others(after)
}
