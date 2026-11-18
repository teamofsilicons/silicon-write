//! Personal suggestions combine the caller's own shares with their consented Silicon Contacts.
use crate::{
    accounts::{self, Account},
    auth::{Auth, Caller},
    error::{ApiError, ApiResult},
    state::AppState,
};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use reqwest::RequestBuilder;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use silicon_accounts_client::types::IssueUserVerification;
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

#[derive(Serialize, Deserialize)]
pub struct Connection {
    connected: bool,
}

async fn connected(state: &AppState, uuid: &str) -> ApiResult<bool> {
    Ok(sqlx::query_scalar(
        "select exists(select 1 from contact_connections where account_uuid = $1)",
    )
    .bind(uuid)
    .fetch_one(&state.db)
    .await?)
}
pub async fn connection(
    State(state): State<AppState>,
    Auth(c): Auth,
) -> ApiResult<Json<Connection>> {
    Ok(Json(Connection {
        connected: connected(&state, &c.uuid).await?,
    }))
}
pub async fn set_connection(
    State(state): State<AppState>,
    Auth(c): Auth,
    Json(body): Json<Connection>,
) -> ApiResult<Json<Connection>> {
    if body.connected {
        sqlx::query(
            "insert into contact_connections(account_uuid) values($1) on conflict do nothing",
        )
        .bind(&c.uuid)
        .execute(&state.db)
        .await?;
    } else {
        sqlx::query("delete from contact_connections where account_uuid = $1")
            .bind(&c.uuid)
            .execute(&state.db)
            .await?;
    }
    Ok(Json(body))
}
fn unavailable() -> ApiError {
    ApiError::unavailable("Silicon Contacts could not be reached. Try again shortly.")
}
async fn proof(state: &AppState, c: &Caller, scope: &str) -> ApiResult<String> {
    if !connected(state, &c.uuid).await? {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "contacts_disconnected",
            "Connect Silicon Contacts to use your address book in Write.",
        ));
    }
    let request = IssueUserVerification {
        subject_token: c.token.clone(),
        receiving_app: "silicon-contacts".into(),
        scopes: vec![scope.into()],
        access_ttl_seconds: Some(120),
    };
    let verified = state
        .app()
        .issue_user_verification(&request, Some(&crate::ids::new_id("contacts")))
        .await
        .map_err(|e| match e.status() {
            Some(401 | 403) => ApiError::forbidden("Accounts declined this Contacts operation."),
            _ => unavailable(),
        })?;
    Ok(verified.proof_token.expose().to_owned())
}
fn request(state: &AppState, proof: &str, method: reqwest::Method, path: &str) -> RequestBuilder {
    state
        .http
        .request(
            method,
            format!(
                "{}/v1/{path}",
                state.config.contacts_url.trim_end_matches('/')
            ),
        )
        .header(header::AUTHORIZATION, format!("Proof {proof}"))
}
async fn receive(request: RequestBuilder) -> ApiResult<reqwest::Response> {
    let res = request.send().await.map_err(|_| unavailable())?;
    let status = res.status();
    if status.is_success() {
        return Ok(res);
    }
    let body: Value = res.json().await.unwrap_or_default();
    let message = body
        .pointer("/error/message")
        .and_then(Value::as_str)
        .unwrap_or("Silicon Contacts declined this request.");
    Err(match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => ApiError::forbidden(message),
        StatusCode::NOT_FOUND => ApiError::new(status, "contact_not_found", message),
        s if s.is_client_error() => ApiError::new(s, "contacts_error", message),
        _ => unavailable(),
    })
}

#[derive(Clone, Serialize)]
struct Person {
    #[serde(flatten)]
    account: Account,
    trust: u8,
    photo_url: Option<String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    email: String,
}
impl From<Account> for Person {
    fn from(account: Account) -> Self {
        Self {
            account,
            trust: 0,
            photo_url: None,
            email: String::new(),
        }
    }
}
#[derive(Deserialize)]
struct Contact {
    uuid: String,
    account: Account,
    name: String,
    trust: u8,
    photo_id: Option<Uuid>,
    #[serde(default)]
    email: String,
    #[serde(default)]
    blocked: bool,
}
impl Contact {
    fn person(self, known: Option<&Person>) -> Person {
        let mut a = self.account;
        if !self.name.is_empty() {
            a.display_name = self.name;
        }
        if a.pfp_url.is_empty()
            && let Some(p) = known
        {
            a.pfp_url = p.account.pfp_url.clone();
        }
        Person {
            account: a,
            trust: self.trust,
            email: self.email,
            photo_url: self.photo_id.map(|id| format!("/v1/contacts/photos/{id}")),
        }
    }
}
#[derive(Deserialize)]
struct Page {
    items: Vec<Contact>,
    total: usize,
}
async fn contacts(state: &AppState, c: &Caller) -> ApiResult<Vec<Contact>> {
    let auth = proof(state, c, "contacts.read").await?;
    let mut all = Vec::new();
    loop {
        let req = request(state, &auth, reqwest::Method::GET, "contacts")
            .query(&[("offset", all.len()), ("limit", 200)]);
        let page: Page = receive(req)
            .await?
            .json()
            .await
            .map_err(|_| unavailable())?;
        if page.items.is_empty() {
            break;
        }
        all.extend(page.items);
        if all.len() >= page.total {
            break;
        }
    }
    Ok(all)
}
#[derive(Deserialize, Default)]
pub struct Search {
    #[serde(default)]
    q: String,
    #[serde(default)]
    offset: usize,
    limit: Option<usize>,
}

fn matches(text: &str, query: &str) -> bool {
    let lower = text.to_lowercase();
    let mut chars = lower.chars();
    query
        .chars()
        .filter(|c| !c.is_whitespace())
        .all(|c| chars.any(|x| x == c))
}
pub async fn list(
    State(state): State<AppState>,
    Auth(c): Auth,
    Query(q): Query<Search>,
) -> ApiResult<Json<Value>> {
    let peers: Vec<String> = sqlx::query_scalar("select account_uuid from shares where invited_by=$1 and account_uuid is not null
        union select invited_by from shares where account_uuid=$1 union select from_uuid from transfers where to_uuid=$1
        union select to_uuid from transfers where from_uuid=$1").bind(&c.uuid).fetch_all(&state.db).await?;
    let mut people: HashMap<_, Person> = accounts::many(&state, &peers)
        .await?
        .into_iter()
        .map(|(k, v)| (k, v.into()))
        .collect();
    let status = if connected(&state, &c.uuid).await? {
        match contacts(&state, &c).await {
            Ok(saved) => {
                let mut blocked = HashSet::new();
                for s in saved {
                    let id = s.uuid.clone();
                    if s.blocked {
                        blocked.insert(id);
                    } else {
                        let p = s.person(people.get(&id));
                        people.insert(id, p);
                    }
                }
                people.retain(|id, _| !blocked.contains(id));
                "connected"
            }
            Err(_) => "unavailable",
        }
    } else {
        "disconnected"
    };
    people.remove(&c.uuid);
    let term = q.q.trim().to_lowercase();
    let mut result = people
        .into_values()
        .filter(|p| {
            [&p.account.id, &p.account.display_name, &p.email]
                .iter()
                .any(|v| matches(v, &term))
        })
        .collect::<Vec<_>>();
    result.sort_by(|a, b| {
        b.trust
            .cmp(&a.trust)
            .then_with(|| {
                a.account
                    .display_name
                    .to_lowercase()
                    .cmp(&b.account.display_name.to_lowercase())
            })
            .then(a.account.uuid.cmp(&b.account.uuid))
    });
    let total = result.len();
    let limit = q.limit.unwrap_or(100).clamp(1, 200);
    Ok(Json(
        json!({"items":result.into_iter().skip(q.offset).take(limit).collect::<Vec<_>>(),"offset":q.offset,"limit":limit,"total":total,"contacts_status":status}),
    ))
}

pub async fn lookup(
    State(state): State<AppState>,
    Auth(c): Auth,
    Query(q): Query<Search>,
) -> ApiResult<Json<Value>> {
    let a = accounts::by_public_id(&state, &q.q).await?;
    let mut p = Person::from(a);
    if connected(&state, &c.uuid).await? {
        let auth = proof(&state, &c, "contacts.read").await?;
        let req = request(
            &state,
            &auth,
            reqwest::Method::GET,
            &format!("contacts/{}", p.account.uuid),
        );
        match receive(req).await {
            Ok(res) => {
                let s: Contact = res.json().await.map_err(|_| unavailable())?;
                if s.blocked {
                    return Err(ApiError::not_found("This account"));
                }
                p = s.person(Some(&p));
            }
            Err(e) if e.status == StatusCode::NOT_FOUND => (),
            Err(e) => return Err(e),
        }
    }
    Ok(Json(json!({"person":p})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewContact {
    id: String,
    name: String,
    trust: u8,
}
pub async fn save(
    State(state): State<AppState>,
    Auth(c): Auth,
    Json(input): Json<NewContact>,
) -> ApiResult<impl IntoResponse> {
    if input.trust == 0 || input.name.trim().is_empty() || input.name.len() > 200 {
        return Err(ApiError::invalid(
            "Choose a name up to 200 bytes and trust from 1 to 255.",
        ));
    }
    let account = accounts::by_public_id(&state, &input.id).await?;
    let read = proof(&state, &c, "contacts.read").await?;
    let mut tx = state.db.begin().await?;
    sqlx::query("select pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("contact:{}:{}", c.uuid, account.uuid))
        .execute(&mut *tx)
        .await?;
    let req = request(
        &state,
        &read,
        reqwest::Method::GET,
        &format!("contacts/{}", account.uuid),
    );
    match receive(req).await {
        Ok(_) => {
            return Err(ApiError::conflict(
                "This account is already in your contacts.",
            ));
        }
        Err(e) if e.status == StatusCode::NOT_FOUND => (),
        Err(e) => return Err(e),
    }
    let write = proof(&state, &c, "contacts.write").await?;
    let res = receive(
        request(&state, &write, reqwest::Method::POST, "contacts")
            .json(&json!({"id":account.uuid,"name":input.name.trim(),"trust":input.trust})),
    )
    .await?;
    let saved: Contact = res.json().await.map_err(|_| unavailable())?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({"person":saved.person(Some(&account.into()))})),
    ))
}

pub async fn photo(
    State(state): State<AppState>,
    Auth(c): Auth,
    Path(id): Path<Uuid>,
) -> ApiResult<Response> {
    let auth = proof(&state, &c, "contacts.read").await?;
    let res = receive(request(
        &state,
        &auth,
        reqwest::Method::GET,
        &format!("photos/{id}"),
    ))
    .await?;
    Ok((
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "private, no-store"),
        ],
        axum::body::Body::from_stream(res.bytes_stream()),
    )
        .into_response())
}
