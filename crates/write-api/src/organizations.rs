use crate::{
    auth::{Auth, Caller},
    error::{ApiError, ApiResult},
    state::AppState,
};
use axum::{
    Json,
    extract::{Path, State},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Organization {
    pub org_id: String,
    name: String,
    pub capabilities: Capabilities,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Capabilities {
    pub admin: bool,
    owner: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Target {
    #[serde(rename = "type")]
    kind: String,
    id: String,
    pub org_id: String,
    pub name: String,
}
impl Target {
    pub fn key(&self) -> String {
        format!("{}:{}", self.kind, self.id)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Context {
    account_uuid: String,
    organizations: Vec<Organization>,
    pub groups: Vec<String>,
    pub share_targets: Vec<Target>,
}
pub async fn context<'a>(state: &AppState, c: &'a Caller) -> ApiResult<&'a Context> {
    c.organizations
        .get_or_try_init(|| async {
            let res = state
                .http
                .get(format!(
                    "{}/v1/integrations/{}/me",
                    state.config.organizations_url.trim_end_matches('/'),
                    state.config.app_id
                ))
                .bearer_auth(&c.token)
                .timeout(std::time::Duration::from_secs(12))
                .send()
                .await
                .map_err(|_| {
                    ApiError::unavailable("Silicon Organizations could not verify your membership.")
                })?;
            match res.status().as_u16() {
                200 => (),
                401 => return Err(ApiError::unauthorized()),
                403 => return Err(ApiError::forbidden("This work account cannot use Write.")),
                _ => {
                    return Err(ApiError::unavailable(
                        "Silicon Organizations could not verify your membership.",
                    ));
                }
            }
            let data: Context = res.json().await.map_err(|_| {
                ApiError::unavailable("Silicon Organizations returned an incomplete membership.")
            })?;
            if data.account_uuid != c.uuid {
                return Err(ApiError::forbidden(
                    "The organization session belongs to a different account.",
                ));
            }
            Ok(data)
        })
        .await
}
pub async fn me(State(state): State<AppState>, Auth(c): Auth) -> ApiResult<Json<Context>> {
    Ok(Json(context(&state, &c).await?.clone()))
}
#[derive(Serialize, Deserialize, sqlx::FromRow)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub default_role: String,
    pub members_can_share: bool,
}
pub async fn saved(state: &AppState, org: &str) -> ApiResult<Settings> {
    Ok(sqlx::query_as(
        "select default_role,members_can_share from organization_settings where org_id=$1",
    )
    .bind(org)
    .fetch_optional(&state.db)
    .await?
    .unwrap_or(Settings {
        default_role: "viewer".into(),
        members_can_share: true,
    }))
}
fn member<'a>(context: &'a Context, id: &str) -> ApiResult<&'a Organization> {
    context
        .organizations
        .iter()
        .find(|o| o.org_id == id)
        .ok_or_else(|| ApiError::forbidden("This account is not a member with access to Write."))
}
pub async fn settings(
    State(state): State<AppState>,
    Auth(c): Auth,
    Path(id): Path<String>,
) -> ApiResult<Json<Settings>> {
    member(context(&state, &c).await?, &id)?;
    Ok(Json(saved(&state, &id).await?))
}
pub async fn update(
    State(state): State<AppState>,
    Auth(c): Auth,
    Path(id): Path<String>,
    Json(input): Json<Settings>,
) -> ApiResult<Json<Settings>> {
    if !member(context(&state, &c).await?, &id)?.capabilities.admin {
        return Err(ApiError::forbidden(
            "Only an organization administrator can change Write settings.",
        ));
    }
    if !matches!(
        input.default_role.as_str(),
        "viewer" | "commenter" | "editor"
    ) {
        return Err(ApiError::invalid("Choose viewer, commenter or editor."));
    }
    sqlx::query("insert into organization_settings values($1,$2,$3) on conflict(org_id) do update set default_role=excluded.default_role,members_can_share=excluded.members_can_share")
        .bind(id).bind(&input.default_role).bind(input.members_can_share).execute(&state.db).await?;
    Ok(Json(input))
}
pub async fn target<'a>(state: &AppState, c: &'a Caller, key: &str) -> ApiResult<&'a Target> {
    let ctx = context(state, c).await?;
    let t = ctx
        .share_targets
        .iter()
        .find(|g| g.key() == key)
        .ok_or_else(|| {
            ApiError::forbidden("This team or organization is unavailable to this account.")
        })?;
    if !member(ctx, &t.org_id)?.capabilities.admin
        && !saved(state, &t.org_id).await?.members_can_share
    {
        return Err(ApiError::forbidden(
            "An organization administrator must share with this group.",
        ));
    }
    Ok(t)
}
/// Skip the external call when there are no group grants to consider.
pub async fn library_groups(state: &AppState, c: &Caller) -> ApiResult<Vec<String>> {
    if !sqlx::query_scalar::<_, bool>(
        "select exists(select 1 from shares where group_key is not null)",
    )
    .fetch_one(&state.db)
    .await?
    {
        return Ok(vec![]);
    }
    Ok(context(state, c).await?.groups.clone())
}
