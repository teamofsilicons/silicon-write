//! The HTTP client: authentication, request plumbing and one method per route of `docs/api.md`.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use futures::future::BoxFuture;
use futures::{Stream, StreamExt, TryStreamExt};
use reqwest::{Method, RequestBuilder, Response, StatusCode, Url};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::error::{Error, Result};
use crate::types::*;

/// The production API.
pub const DEFAULT_API_URL: &str = "https://api.write.teamofsilicons.com";

/// This crate's version.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Supplies access tokens and refreshes them. Implement it to keep a session that refreshes
/// itself: the client asks for a token before each request and, when the service answers
/// 401, asks for a refreshed one once and retries.
pub trait TokenProvider: Send + Sync {
    /// The access token to send now, or `None` to send the request without one (public docs).
    fn token(&self) -> BoxFuture<'_, Result<Option<String>>>;

    /// The service refused `rejected`: return a fresh token, or `None` when there is none.
    fn refresh<'a>(&'a self, rejected: &'a str) -> BoxFuture<'a, Result<Option<String>>>;
}

#[derive(Clone)]
enum Auth {
    None,
    Token(String),
    Provider(Arc<dyn TokenProvider>),
}

/// A file to upload (import or image).
#[derive(Debug, Clone)]
pub struct Upload {
    /// The file name sent with it (its extension tells the service the format).
    pub file_name: String,
    /// Content.
    pub bytes: Bytes,
    /// Media type (guessed from the extension when `None`).
    pub content_type: Option<String>,
}

impl Upload {
    /// An upload from memory.
    pub fn new(file_name: impl Into<String>, bytes: impl Into<Bytes>) -> Self {
        Self {
            file_name: file_name.into(),
            bytes: bytes.into(),
            content_type: None,
        }
    }

    /// Reads a local file.
    pub async fn from_path(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let bytes = tokio::fs::read(path).await.map_err(|e| {
            Error::io(
                format!("Could not read {}: {e}.", path.display()),
                "Check the path and that the file is readable.",
                e,
            )
        })?;
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "file".into());
        Ok(Self::new(file_name, bytes))
    }

    fn part(&self) -> Result<reqwest::multipart::Part> {
        let mime = self
            .content_type
            .clone()
            .unwrap_or_else(|| guess_mime(&self.file_name).to_owned());
        reqwest::multipart::Part::bytes(self.bytes.to_vec())
            .file_name(self.file_name.clone())
            .mime_str(&mime)
            .map_err(|e| {
                Error::invalid_input(
                    format!("`{mime}` is not a valid media type ({e})."),
                    "Pass a type like text/markdown.",
                )
            })
    }
}

/// Media type from a file name's extension.
pub fn guess_mime(file_name: &str) -> &'static str {
    let ext = file_name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "md" | "markdown" => "text/markdown",
        "txt" => "text/plain",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "doc" => "application/msword",
        "odt" => "application/vnd.oasis.opendocument.text",
        "rtf" => "application/rtf",
        "html" | "htm" => "text/html",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

/// A file the service sends back (export, original PDF, asset), streamed.
#[derive(Debug)]
pub struct Download {
    /// The name from `Content-Disposition`, if any.
    pub file_name: Option<String>,
    /// `Content-Type`.
    pub content_type: Option<String>,
    /// `Content-Length`.
    pub content_length: Option<u64>,
    response: Response,
}

impl Download {
    fn new(response: Response) -> Self {
        let header = |name: reqwest::header::HeaderName| {
            response
                .headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned)
        };
        let file_name = header(reqwest::header::CONTENT_DISPOSITION)
            .and_then(|v| content_disposition_filename(&v));
        let content_type = header(reqwest::header::CONTENT_TYPE);
        let content_length = response.content_length();
        Self {
            file_name,
            content_type,
            content_length,
            response,
        }
    }

    /// The body as a stream of chunks.
    pub fn bytes_stream(self) -> impl Stream<Item = Result<Bytes>> {
        self.response.bytes_stream().map_err(network_error)
    }

    /// The whole body.
    pub async fn bytes(self) -> Result<Bytes> {
        self.response.bytes().await.map_err(network_error)
    }

    /// Streams the body into `writer`; returns the number of bytes written.
    pub async fn write_to<W: tokio::io::AsyncWrite + Unpin>(self, writer: &mut W) -> Result<u64> {
        use tokio::io::AsyncWriteExt;
        let mut stream = std::pin::pin!(self.bytes_stream());
        let mut total = 0u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            writer.write_all(&chunk).await.map_err(|e| {
                Error::io(
                    format!("Could not write the download: {e}."),
                    "Check the destination and free space.",
                    e,
                )
            })?;
            total += chunk.len() as u64;
        }
        writer.flush().await.map_err(|e| {
            Error::io(
                format!("Could not write the download: {e}."),
                "Check the destination and free space.",
                e,
            )
        })?;
        Ok(total)
    }
}

/// The file name from a `Content-Disposition` header (`filename*=UTF-8''…` preferred).
pub fn content_disposition_filename(value: &str) -> Option<String> {
    let mut plain = None;
    for part in value.split(';').map(str::trim) {
        let Some((key, val)) = part.split_once('=') else {
            continue;
        };
        match key.trim().to_ascii_lowercase().as_str() {
            "filename*" => {
                let encoded = val.trim().trim_matches('"');
                let encoded = encoded
                    .split_once("''")
                    .map(|(_, rest)| rest)
                    .unwrap_or(encoded);
                let decoded = percent_encoding::percent_decode_str(encoded)
                    .decode_utf8_lossy()
                    .into_owned();
                if !decoded.is_empty() {
                    return Some(decoded);
                }
            }
            "filename" => {
                let v = val.trim();
                let v = v
                    .strip_prefix('"')
                    .and_then(|v| v.strip_suffix('"'))
                    .unwrap_or(v);
                plain = Some(v.replace("\\\"", "\""));
            }
            _ => {}
        }
    }
    plain.filter(|p| !p.is_empty())
}

pub(crate) fn network_error(source: reqwest::Error) -> Error {
    let what = if source.is_timeout() {
        "timed out"
    } else if source.is_connect() {
        "could not connect"
    } else {
        "failed"
    };
    let url = source
        .url()
        .map(|u| format!(" ({})", u.origin().ascii_serialization()))
        .unwrap_or_default();
    Error::Network {
        message: format!("The request to Silicon Write{url} {what}: {source}."),
        hint: "Check your connection and the API URL (WRITE_API_URL); the service answers GET /healthz when it is up.".into(),
        source,
    }
}

/// Builds a [`Client`].
#[derive(Debug, Clone)]
pub struct ClientBuilder {
    base_url: String,
    timeout: Duration,
    connect_timeout: Duration,
    user_agent: Option<String>,
}

impl Default for ClientBuilder {
    fn default() -> Self {
        Self {
            base_url: DEFAULT_API_URL.into(),
            timeout: Duration::from_secs(120),
            connect_timeout: Duration::from_secs(10),
            user_agent: None,
        }
    }
}

impl ClientBuilder {
    /// The API URL (default [`DEFAULT_API_URL`]).
    pub fn base_url(mut self, url: impl Into<String>) -> Self {
        self.base_url = url.into();
        self
    }

    /// Total time for one request (default 120 s; downloads stream within it).
    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// Time to connect (default 10 s).
    pub fn connect_timeout(mut self, timeout: Duration) -> Self {
        self.connect_timeout = timeout;
        self
    }

    /// A product token put before this crate's in the User-Agent, e.g. `write/0.1.0`.
    pub fn user_agent(mut self, product: impl Into<String>) -> Self {
        self.user_agent = Some(product.into());
        self
    }

    /// Builds the client (without credentials; add them with [`Client::with_token`] or
    /// [`Client::with_token_provider`]).
    pub fn build(self) -> Result<Client> {
        let trimmed = self.base_url.trim().trim_end_matches('/');
        let base = Url::parse(trimmed).map_err(|e| {
            Error::invalid_input(
                format!("The Silicon Write API URL `{trimmed}` is not a valid absolute URL ({e})."),
                format!("Use a full URL such as {DEFAULT_API_URL} or http://127.0.0.1:4371."),
            )
        })?;
        if !matches!(base.scheme(), "http" | "https") {
            return Err(Error::invalid_input(
                format!(
                    "The Silicon Write API URL `{trimmed}` must use https (or http for this machine)."
                ),
                format!("Use a URL such as {DEFAULT_API_URL}."),
            ));
        }
        let user_agent = match &self.user_agent {
            Some(product) => format!("{product} silicon-write-client/{VERSION}"),
            None => format!("silicon-write-client/{VERSION}"),
        };
        let http = reqwest::Client::builder()
            .user_agent(user_agent)
            .timeout(self.timeout)
            .connect_timeout(self.connect_timeout)
            .build()
            .map_err(|e| {
                Error::invalid_input(
                    format!("Could not set up HTTP: {e}."),
                    "This is a bug; please report it.",
                )
            })?;
        Ok(Client {
            http,
            base,
            auth: Auth::None,
        })
    }
}

/// The Silicon Write API client. Cheap to clone.
#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    base: Url,
    auth: Auth,
}

impl std::fmt::Debug for Client {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let auth = match self.auth {
            Auth::None => "none",
            Auth::Token(_) => "token",
            Auth::Provider(_) => "provider",
        };
        f.debug_struct("Client")
            .field("base", &self.base.as_str())
            .field("auth", &auth)
            .finish()
    }
}

/// Builds a JSON request body.
fn body(value: impl Serialize) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

impl Client {
    /// A client for `base_url` without credentials (public docs only).
    pub fn new(base_url: impl Into<String>) -> Result<Self> {
        Self::builder().base_url(base_url).build()
    }

    /// A [`ClientBuilder`].
    pub fn builder() -> ClientBuilder {
        ClientBuilder::default()
    }

    /// The same client sending this access token.
    pub fn with_token(mut self, access_token: impl Into<String>) -> Self {
        self.auth = Auth::Token(access_token.into());
        self
    }

    /// The same client asking `provider` for tokens (and for a fresh one after a 401).
    pub fn with_token_provider(mut self, provider: Arc<dyn TokenProvider>) -> Self {
        self.auth = Auth::Provider(provider);
        self
    }

    /// The API URL.
    pub fn base_url(&self) -> &Url {
        &self.base
    }

    /// Builds `{base}/{segments…}` with each segment percent-encoded.
    pub fn url(&self, segments: &[&str]) -> Url {
        let mut url = self.base.clone();
        {
            let mut path = url.path_segments_mut().expect("http URLs have a path");
            path.pop_if_empty();
            path.extend(segments);
        }
        url
    }

    async fn current_token(&self) -> Result<Option<String>> {
        match &self.auth {
            Auth::None => Ok(None),
            Auth::Token(t) => Ok(Some(t.clone())),
            Auth::Provider(p) => p.token().await,
        }
    }

    /// Sends a request built by `build` (called again for the retry after a refresh) and
    /// returns the successful response.
    async fn execute(
        &self,
        build: impl Fn(&reqwest::Client) -> Result<RequestBuilder>,
    ) -> Result<Response> {
        let token = self.current_token().await?;
        let response = self.send_once(&build, token.as_deref()).await?;
        if response.status() == StatusCode::UNAUTHORIZED
            && let (Auth::Provider(provider), Some(used)) = (&self.auth, token.as_deref())
            && let Some(fresh) = provider.refresh(used).await?
        {
            let response = self.send_once(&build, Some(&fresh)).await?;
            return check(response).await;
        }
        check(response).await
    }

    async fn send_once(
        &self,
        build: &impl Fn(&reqwest::Client) -> Result<RequestBuilder>,
        token: Option<&str>,
    ) -> Result<Response> {
        let mut request = build(&self.http)?;
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        request.send().await.map_err(network_error)
    }

    async fn json<T: DeserializeOwned>(
        &self,
        build: impl Fn(&reqwest::Client) -> Result<RequestBuilder>,
    ) -> Result<T> {
        let response = self.execute(build).await?;
        decode(response).await
    }

    async fn get<T: DeserializeOwned>(
        &self,
        segments: &[&str],
        query: &[(&str, String)],
    ) -> Result<T> {
        let url = self.url(segments);
        self.json(|http| Ok(http.get(url.clone()).query(query)))
            .await
    }

    async fn send_json<T: DeserializeOwned>(
        &self,
        method: Method,
        segments: &[&str],
        payload: Option<Value>,
    ) -> Result<T> {
        let url = self.url(segments);
        self.json(|http| {
            let request = http.request(method.clone(), url.clone());
            Ok(match &payload {
                Some(p) => request.json(p),
                None => request,
            })
        })
        .await
    }

    async fn send_empty(
        &self,
        method: Method,
        segments: &[&str],
        query: &[(&str, String)],
        payload: Option<Value>,
    ) -> Result<()> {
        let url = self.url(segments);
        self.execute(|http| {
            let request = http.request(method.clone(), url.clone()).query(query);
            Ok(match &payload {
                Some(p) => request.json(p),
                None => request,
            })
        })
        .await
        .map(|_| ())
    }

    async fn multipart<T: DeserializeOwned>(
        &self,
        segments: &[&str],
        upload: &Upload,
        fields: &[(&str, String)],
    ) -> Result<T> {
        let url = self.url(segments);
        self.json(|http| {
            let mut form = reqwest::multipart::Form::new().part("file", upload.part()?);
            for (name, value) in fields {
                form = form.text(name.to_string(), value.clone());
            }
            Ok(http.post(url.clone()).multipart(form))
        })
        .await
    }

    async fn download(&self, segments: &[&str], query: &[(&str, String)]) -> Result<Download> {
        let url = self.url(segments);
        let response = self
            .execute(|http| Ok(http.get(url.clone()).query(query)))
            .await?;
        Ok(Download::new(response))
    }

    // ── Service ──────────────────────────────────────────────────────────────────────────

    /// `GET /healthz`: `Ok` when the service is up.
    pub async fn healthz(&self) -> Result<()> {
        self.send_empty(Method::GET, &["healthz"], &[], None).await
    }

    /// `GET /readyz`: `Ok` when the service is ready to serve.
    pub async fn readyz(&self) -> Result<()> {
        self.send_empty(Method::GET, &["readyz"], &[], None).await
    }

    // ── Me ───────────────────────────────────────────────────────────────────────────────

    /// `GET /v1/me`: the signed-in account.
    pub async fn me(&self) -> Result<Account> {
        let me: Me = self.get(&["v1", "me"], &[]).await?;
        Ok(me.account)
    }

    // ── Docs and folders ─────────────────────────────────────────────────────────────────

    /// `GET /v1/library`: a top level (`folder = None`) or a folder's content.
    pub async fn library(&self, view: LibraryView, folder: Option<&str>) -> Result<Library> {
        let mut query = vec![("view", view.as_str().to_owned())];
        if let Some(folder) = folder {
            query.push(("folder", folder.to_owned()));
        }
        self.get(&["v1", "library"], &query).await
    }

    /// `GET /v1/docs`: every doc the caller can open.
    pub async fn docs(&self) -> Result<Vec<Doc>> {
        let list: DocList = self.get(&["v1", "docs"], &[]).await?;
        Ok(list.docs)
    }

    /// `GET /v1/folders`: every folder the caller can open.
    pub async fn folders(&self) -> Result<Vec<Folder>> {
        let list: FolderList = self.get(&["v1", "folders"], &[]).await?;
        Ok(list.folders)
    }

    /// `POST /v1/docs`.
    pub async fn create_doc(&self, new: &NewDoc) -> Result<Doc> {
        self.send_json(Method::POST, &["v1", "docs"], Some(body(new)))
            .await
    }

    /// `POST /v1/docs/import`: a new doc from a file (`.md .txt .docx .doc .odt .rtf .html .pdf`).
    pub async fn import_doc(
        &self,
        upload: &Upload,
        folder_id: Option<&str>,
        title: Option<&str>,
    ) -> Result<Doc> {
        let mut fields = Vec::new();
        if let Some(folder) = folder_id {
            fields.push(("folder_id", folder.to_owned()));
        }
        if let Some(title) = title {
            fields.push(("title", title.to_owned()));
        }
        self.multipart(&["v1", "docs", "import"], upload, &fields)
            .await
    }

    /// `POST /v1/docs/{id}/import`: opens a file on top of a doc; it becomes the next version.
    pub async fn import_into(&self, doc: &str, upload: &Upload) -> Result<SeqResult> {
        self.multipart(&["v1", "docs", doc, "import"], upload, &[])
            .await
    }

    /// `GET /v1/docs/{id}` (public).
    pub async fn doc(&self, doc: &str) -> Result<Doc> {
        self.get(&["v1", "docs", doc], &[]).await
    }

    /// `PATCH /v1/docs/{id}`: rename and/or move.
    pub async fn update_doc(&self, doc: &str, patch: &DocPatch) -> Result<Doc> {
        self.send_json(Method::PATCH, &["v1", "docs", doc], Some(body(patch)))
            .await
    }

    /// `DELETE /v1/docs/{id}`: to the trash.
    pub async fn delete_doc(&self, doc: &str) -> Result<()> {
        self.send_empty(Method::DELETE, &["v1", "docs", doc], &[], None)
            .await
    }

    /// `POST /v1/docs/{id}/restore` (no body): back from the trash.
    pub async fn restore_doc(&self, doc: &str) -> Result<Doc> {
        self.send_json(Method::POST, &["v1", "docs", doc, "restore"], None)
            .await
    }

    /// `DELETE /v1/docs/{id}/permanently?confirm={id}`: gone for good (only from the trash).
    pub async fn purge_doc(&self, doc: &str) -> Result<()> {
        self.send_empty(
            Method::DELETE,
            &["v1", "docs", doc, "permanently"],
            &[("confirm", doc.to_owned())],
            None,
        )
        .await
    }

    /// `POST /v1/docs/{id}/copy`.
    pub async fn copy_doc(&self, doc: &str, copy: &CopyDoc) -> Result<Doc> {
        self.send_json(Method::POST, &["v1", "docs", doc, "copy"], Some(body(copy)))
            .await
    }

    /// `POST /v1/docs/{id}/convert`: a `pdf` doc becomes a normal doc.
    pub async fn convert_doc(&self, doc: &str) -> Result<Doc> {
        self.send_json(Method::POST, &["v1", "docs", doc, "convert"], None)
            .await
    }

    /// `GET /v1/docs/{id}/original` (public): the uploaded original file.
    pub async fn original(&self, doc: &str) -> Result<Download> {
        self.download(&["v1", "docs", doc, "original"], &[]).await
    }

    /// `POST /v1/folders`.
    pub async fn create_folder(&self, name: &str, parent_id: Option<&str>) -> Result<Folder> {
        let mut payload = json!({ "name": name });
        if let Some(parent) = parent_id {
            payload["parent_id"] = json!(parent);
        }
        self.send_json(Method::POST, &["v1", "folders"], Some(payload))
            .await
    }

    /// `GET /v1/folders/{id}`.
    pub async fn folder(&self, folder: &str) -> Result<Folder> {
        self.get(&["v1", "folders", folder], &[]).await
    }

    /// `PATCH /v1/folders/{id}`: rename and/or move.
    pub async fn update_folder(&self, folder: &str, patch: &FolderPatch) -> Result<Folder> {
        self.send_json(Method::PATCH, &["v1", "folders", folder], Some(body(patch)))
            .await
    }

    /// `DELETE /v1/folders/{id}`: to the trash with its content.
    pub async fn delete_folder(&self, folder: &str) -> Result<()> {
        self.send_empty(Method::DELETE, &["v1", "folders", folder], &[], None)
            .await
    }

    /// `POST /v1/folders/{id}/restore`.
    pub async fn restore_folder(&self, folder: &str) -> Result<Folder> {
        self.send_json(Method::POST, &["v1", "folders", folder, "restore"], None)
            .await
    }

    /// `DELETE /v1/folders/{id}/permanently?confirm={id}`.
    pub async fn purge_folder(&self, folder: &str) -> Result<()> {
        self.send_empty(
            Method::DELETE,
            &["v1", "folders", folder, "permanently"],
            &[("confirm", folder.to_owned())],
            None,
        )
        .await
    }

    // ── Content ──────────────────────────────────────────────────────────────────────────

    /// `GET /v1/docs/{id}/markdown` (public).
    pub async fn markdown(&self, doc: &str, options: MarkdownOptions) -> Result<DocMarkdown> {
        let suggestions = match options.suggestions {
            SuggestionsView::Current => "current",
            SuggestionsView::Critic => "critic",
        };
        let comments = if options.inline_comments {
            "inline"
        } else {
            "none"
        };
        self.get(
            &["v1", "docs", doc, "markdown"],
            &[
                ("suggestions", suggestions.to_owned()),
                ("comments", comments.to_owned()),
            ],
        )
        .await
    }

    /// `GET /v1/docs/{id}/prosemirror?seq=` (public): ProseMirror JSON for rendering.
    pub async fn prosemirror(&self, doc: &str, seq: Option<i64>) -> Result<Value> {
        let query: Vec<(&str, String)> = seq.map(|s| ("seq", s.to_string())).into_iter().collect();
        self.get(&["v1", "docs", doc, "prosemirror"], &query).await
    }

    /// `POST /v1/docs/{id}/edits`: exact-text replacements, applied together and merged.
    pub async fn edit(&self, doc: &str, edits: &[Edit], suggest: bool) -> Result<EditResult> {
        self.edit_expecting(doc, edits, suggest, None).await
    }

    /// Exact replacements with an optional atomic content-version check. A stale `expect_seq`
    /// returns a conflict without applying any edits; reread before deciding whether to retry.
    pub async fn edit_expecting(
        &self,
        doc: &str,
        edits: &[Edit],
        suggest: bool,
        expect_seq: Option<i64>,
    ) -> Result<EditResult> {
        if edits.is_empty() {
            return Err(Error::invalid_input(
                "There are no edits to send.",
                "Pass at least one {old, new} pair.",
            ));
        }
        let mut payload = json!({ "edits": edits });
        if let Some(seq) = expect_seq {
            if seq < 0 {
                return Err(Error::invalid_input(
                    "The expected version cannot be negative.",
                    "Use the seq from write context or write cat --json.",
                ));
            }
            payload["expect_seq"] = json!(seq);
        }
        if suggest {
            payload["suggest"] = json!(true);
        }
        self.send_json(Method::POST, &["v1", "docs", doc, "edits"], Some(payload))
            .await
    }

    /// `PUT /v1/docs/{id}/markdown`: a whole new version. With `base_seq`, only what changed
    /// since that version is applied, merged with everything after it.
    pub async fn put_markdown(
        &self,
        doc: &str,
        markdown: &str,
        base_seq: Option<i64>,
        suggest: bool,
    ) -> Result<EditResult> {
        let mut payload = json!({ "markdown": markdown });
        if let Some(seq) = base_seq {
            payload["base_seq"] = json!(seq);
        }
        if suggest {
            payload["suggest"] = json!(true);
        }
        self.send_json(Method::PUT, &["v1", "docs", doc, "markdown"], Some(payload))
            .await
    }

    /// `GET /v1/docs/{id}/export?format=&seq=` (public): the file, streamed.
    pub async fn export(
        &self,
        doc: &str,
        format: ExportFormat,
        seq: Option<i64>,
    ) -> Result<Download> {
        let mut query = vec![("format", format.as_str().to_owned())];
        if let Some(seq) = seq {
            query.push(("seq", seq.to_string()));
        }
        self.download(&["v1", "docs", doc, "export"], &query).await
    }

    /// `POST /v1/docs/{id}/assets`: uploads an image for the doc.
    pub async fn upload_asset(&self, doc: &str, upload: &Upload) -> Result<Asset> {
        self.multipart(&["v1", "docs", doc, "assets"], upload, &[])
            .await
    }

    /// `GET /v1/assets/{id}` (public with doc access): the image.
    pub async fn asset(&self, asset: &str) -> Result<Download> {
        self.download(&["v1", "assets", asset], &[]).await
    }

    /// `GET /v1/docs/{id}/backlinks`: docs that link here with `[[title]]`.
    pub async fn backlinks(&self, doc: &str) -> Result<Vec<Doc>> {
        let list: DocList = self.get(&["v1", "docs", doc, "backlinks"], &[]).await?;
        Ok(list.docs)
    }

    /// `GET /v1/docs/{id}/authorship`: who wrote each top-level block.
    pub async fn authorship(&self, doc: &str) -> Result<Authorship> {
        self.get(&["v1", "docs", doc, "authorship"], &[]).await
    }

    /// `GET /v1/links?title=`: the doc a `[[title]]` link opens (case-insensitive), if any.
    pub async fn resolve_link(&self, title: &str) -> Result<Option<Doc>> {
        let target: LinkTarget = self
            .get(&["v1", "links"], &[("title", title.to_owned())])
            .await?;
        Ok(target.doc)
    }

    /// `GET /v1/search?q=`.
    pub async fn search(&self, query: &str) -> Result<Vec<SearchResult>> {
        let results: SearchResults = self
            .get(&["v1", "search"], &[("q", query.to_owned())])
            .await?;
        Ok(results.results)
    }

    // ── Real time ────────────────────────────────────────────────────────────────────────

    /// `GET /v1/docs/{id}/context`: content, comments, anchors, authors, revisions and presence.
    pub async fn context(&self, doc: &str) -> Result<DocumentContext> {
        self.get(&["v1", "docs", doc, "context"], &[]).await
    }

    /// Watches document and comment events. `joined` announces genuine presence for this open
    /// connection; dropping the stream leaves the document. Pass the last consumed event id to
    /// resume. A reset event contains a fresh snapshot when the cursor is no longer retained.
    /// Connections are bounded; callers should reconnect and let the token provider refresh auth.
    pub async fn document_events(
        &self,
        doc: &str,
        joined: bool,
        after: Option<&str>,
    ) -> Result<crate::DocumentEvents> {
        let endpoint = if joined { "join" } else { "events" };
        let url = self.url(&["v1", "docs", doc, endpoint]);
        let query: Vec<_> = after.map(|cursor| ("after", cursor)).into_iter().collect();
        let response = self
            .execute(|http| {
                Ok(http
                    .get(url.clone())
                    .header(reqwest::header::ACCEPT, "text/event-stream")
                    .query(&query)
                    .timeout(Duration::from_secs(300)))
            })
            .await?;
        if !response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                value
                    .split(';')
                    .next()
                    .is_some_and(|mime| mime.trim() == "text/event-stream")
            })
        {
            return Err(Error::Decode {
                message: "The document stream did not return server-sent events.".into(),
                hint: "Check the API URL and that the service supports document join/watch.".into(),
            });
        }
        Ok(crate::DocumentEvents::new(response))
    }

    /// `POST /v1/docs/{id}/live` (public): a ticket for the live WebSocket.
    pub async fn live(&self, doc: &str) -> Result<LiveTicket> {
        self.send_json(Method::POST, &["v1", "docs", doc, "live"], None)
            .await
    }

    // ── Sharing ──────────────────────────────────────────────────────────────────────────

    /// `GET /v1/{docs|folders}/{id}/sharing`.
    pub async fn sharing(&self, item: Item<'_>) -> Result<Sharing> {
        self.get(&["v1", item.collection(), item.id(), "sharing"], &[])
            .await
    }

    /// `POST /v1/{docs|folders}/{id}/sharing`: invite a `c:id`, `si:id` or email.
    pub async fn share(&self, item: Item<'_>, to: &str, role: Role) -> Result<Member> {
        self.send_json(
            Method::POST,
            &["v1", item.collection(), item.id(), "sharing"],
            Some(json!({ "to": to, "role": role.as_str() })),
        )
        .await
    }

    /// `PATCH /v1/{docs|folders}/{id}/sharing/{member}`.
    pub async fn update_member(&self, item: Item<'_>, member: &str, role: Role) -> Result<Member> {
        self.send_json(
            Method::PATCH,
            &["v1", item.collection(), item.id(), "sharing", member],
            Some(json!({ "role": role.as_str() })),
        )
        .await
    }

    /// `DELETE /v1/{docs|folders}/{id}/sharing/{member}`.
    pub async fn remove_member(&self, item: Item<'_>, member: &str) -> Result<()> {
        self.send_empty(
            Method::DELETE,
            &["v1", item.collection(), item.id(), "sharing", member],
            &[],
            None,
        )
        .await
    }

    /// `PUT /v1/docs/{id}/public`.
    pub async fn set_public(&self, doc: &str, access: PublicAccess) -> Result<Doc> {
        self.send_json(
            Method::PUT,
            &["v1", "docs", doc, "public"],
            Some(json!({ "access": access.as_str() })),
        )
        .await
    }

    // ── Transfers ────────────────────────────────────────────────────────────────────────

    /// `POST /v1/{docs|folders}/{id}/transfer`.
    pub async fn transfer(&self, item: Item<'_>, to: &str) -> Result<Transfer> {
        self.send_json(
            Method::POST,
            &["v1", item.collection(), item.id(), "transfer"],
            Some(json!({ "to": to })),
        )
        .await
    }

    /// `GET /v1/transfers`.
    pub async fn transfers(&self) -> Result<Transfers> {
        self.get(&["v1", "transfers"], &[]).await
    }

    /// `POST /v1/transfers/{id}/accept|decline|cancel`.
    pub async fn transfer_action(
        &self,
        transfer: &str,
        action: TransferAction,
    ) -> Result<Transfer> {
        self.send_json(
            Method::POST,
            &["v1", "transfers", transfer, action.as_str()],
            None,
        )
        .await
    }

    // ── Comments ─────────────────────────────────────────────────────────────────────────

    /// `GET /v1/docs/{id}/threads?status=`.
    pub async fn threads(&self, doc: &str, status: ThreadStatus) -> Result<Vec<Thread>> {
        let threads: Threads = self
            .get(
                &["v1", "docs", doc, "threads"],
                &[("status", status.as_str().to_owned())],
            )
            .await?;
        Ok(threads.threads)
    }

    /// `POST /v1/docs/{id}/threads`: starts a thread.
    pub async fn create_thread(&self, doc: &str, anchor: &Anchor, body_md: &str) -> Result<Thread> {
        self.send_json(
            Method::POST,
            &["v1", "docs", doc, "threads"],
            Some(json!({ "anchor": anchor, "body": body_md })),
        )
        .await
    }

    /// `POST /v1/threads/{id}/comments`: a reply.
    pub async fn reply(&self, thread: &str, body_md: &str) -> Result<Comment> {
        self.send_json(
            Method::POST,
            &["v1", "threads", thread, "comments"],
            Some(json!({ "body": body_md })),
        )
        .await
    }

    /// `PATCH /v1/comments/{id}` (author).
    pub async fn edit_comment(&self, comment: &str, body_md: &str) -> Result<Comment> {
        self.send_json(
            Method::PATCH,
            &["v1", "comments", comment],
            Some(json!({ "body": body_md })),
        )
        .await
    }

    /// `DELETE /v1/comments/{id}` (author; kept in history as deleted).
    pub async fn delete_comment(&self, comment: &str) -> Result<()> {
        self.send_empty(Method::DELETE, &["v1", "comments", comment], &[], None)
            .await
    }

    /// `POST /v1/comments/{id}/reactions`: toggles the caller's reaction; returns the comment.
    pub async fn react(&self, comment: &str, emoji: &str) -> Result<Comment> {
        self.send_json(
            Method::POST,
            &["v1", "comments", comment, "reactions"],
            Some(json!({ "emoji": emoji })),
        )
        .await
    }

    /// `POST /v1/threads/{id}/resolve`.
    pub async fn resolve(&self, thread: &str) -> Result<Thread> {
        self.send_json(Method::POST, &["v1", "threads", thread, "resolve"], None)
            .await
    }

    /// `POST /v1/threads/{id}/reopen`.
    pub async fn reopen(&self, thread: &str) -> Result<Thread> {
        self.send_json(Method::POST, &["v1", "threads", thread, "reopen"], None)
            .await
    }

    // ── Suggestions ──────────────────────────────────────────────────────────────────────

    /// `GET /v1/docs/{id}/suggestions`.
    pub async fn suggestions(&self, doc: &str) -> Result<Vec<Suggestion>> {
        let list: Suggestions = self.get(&["v1", "docs", doc, "suggestions"], &[]).await?;
        Ok(list.suggestions)
    }

    /// `POST /v1/docs/{id}/suggestions/{sid}/accept`.
    pub async fn accept_suggestion(&self, doc: &str, suggestion: &str) -> Result<SeqResult> {
        self.send_json(
            Method::POST,
            &["v1", "docs", doc, "suggestions", suggestion, "accept"],
            None,
        )
        .await
    }

    /// `POST /v1/docs/{id}/suggestions/{sid}/reject`.
    pub async fn reject_suggestion(&self, doc: &str, suggestion: &str) -> Result<SeqResult> {
        self.send_json(
            Method::POST,
            &["v1", "docs", doc, "suggestions", suggestion, "reject"],
            None,
        )
        .await
    }

    /// `POST /v1/docs/{id}/suggestions/accept-all`.
    pub async fn accept_all_suggestions(&self, doc: &str) -> Result<SeqResult> {
        self.send_json(
            Method::POST,
            &["v1", "docs", doc, "suggestions", "accept-all"],
            None,
        )
        .await
    }

    /// `POST /v1/docs/{id}/suggestions/reject-all`.
    pub async fn reject_all_suggestions(&self, doc: &str) -> Result<SeqResult> {
        self.send_json(
            Method::POST,
            &["v1", "docs", doc, "suggestions", "reject-all"],
            None,
        )
        .await
    }

    // ── Versions and history ─────────────────────────────────────────────────────────────

    /// `GET /v1/docs/{id}/versions`, newest first.
    pub async fn versions(&self, doc: &str) -> Result<Vec<Version>> {
        let list: Versions = self.get(&["v1", "docs", doc, "versions"], &[]).await?;
        Ok(list.versions)
    }

    /// `GET /v1/docs/{id}/versions/{seq}/markdown`.
    pub async fn version_markdown(&self, doc: &str, seq: i64) -> Result<DocMarkdown> {
        self.get(
            &["v1", "docs", doc, "versions", &seq.to_string(), "markdown"],
            &[],
        )
        .await
    }

    /// `PUT /v1/docs/{id}/versions/{seq}/name`.
    pub async fn name_version(&self, doc: &str, seq: i64, name: &str) -> Result<VersionName> {
        self.send_json(
            Method::PUT,
            &["v1", "docs", doc, "versions", &seq.to_string(), "name"],
            Some(json!({ "name": name })),
        )
        .await
    }

    /// `DELETE /v1/docs/{id}/versions/{seq}/name`.
    pub async fn unname_version(&self, doc: &str, seq: i64) -> Result<()> {
        self.send_empty(
            Method::DELETE,
            &["v1", "docs", doc, "versions", &seq.to_string(), "name"],
            &[],
            None,
        )
        .await
    }

    /// `GET /v1/docs/{id}/compare?from=&to=`.
    pub async fn compare(&self, doc: &str, from: i64, to: i64) -> Result<Comparison> {
        self.get(
            &["v1", "docs", doc, "compare"],
            &[("from", from.to_string()), ("to", to.to_string())],
        )
        .await
    }

    /// `POST /v1/docs/{id}/restore-version` with `{seq, blocks?}`: restores a whole version, or
    /// only its top-level blocks `from..to`. Restoring is a new version.
    pub async fn restore_version(
        &self,
        doc: &str,
        seq: i64,
        blocks: Option<(i64, i64)>,
    ) -> Result<SeqResult> {
        let mut payload = json!({ "seq": seq });
        if let Some((from, to)) = blocks {
            payload["blocks"] = json!([from, to]);
        }
        self.send_json(
            Method::POST,
            &["v1", "docs", doc, "restore-version"],
            Some(payload),
        )
        .await
    }

    /// `POST /v1/docs/{id}/undo`: undoes everything `account` changed after version `since`.
    pub async fn undo(&self, doc: &str, account: &str, since: i64) -> Result<SeqResult> {
        self.send_json(
            Method::POST,
            &["v1", "docs", doc, "undo"],
            Some(json!({ "account": account, "since": since })),
        )
        .await
    }

    /// `GET /v1/{docs|folders}/{id}/activity`.
    pub async fn activity(&self, item: Item<'_>) -> Result<Vec<ActivityEvent>> {
        let activity: Activity = self
            .get(&["v1", item.collection(), item.id(), "activity"], &[])
            .await?;
        Ok(activity.events)
    }

    /// `POST /v1/activity/{id}/undo`: undoes a rename, move, delete or create.
    pub async fn undo_activity(&self, event: &str) -> Result<Value> {
        let url = self.url(&["v1", "activity", event, "undo"]);
        let response = self.execute(|http| Ok(http.post(url.clone()))).await?;
        decode_optional(response).await
    }
}

async fn check(response: Response) -> Result<Response> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let body = response.bytes().await.unwrap_or_default();
    Err(Error::from_response(status.as_u16(), &body))
}

async fn decode<T: DeserializeOwned>(response: Response) -> Result<T> {
    let status = response.status();
    let url = response.url().path().to_owned();
    let body = response.bytes().await.map_err(network_error)?;
    let body: &[u8] = if body.is_empty() || status == StatusCode::NO_CONTENT {
        b"null"
    } else {
        &body
    };
    serde_json::from_slice(body).map_err(|e| Error::Decode {
        message: format!(
            "Silicon Write answered {url} with something this client could not read ({e})."
        ),
        hint: "The service and this client may be different versions; update the client.".into(),
    })
}

async fn decode_optional(response: Response) -> Result<Value> {
    let body = response.bytes().await.map_err(network_error)?;
    if body.is_empty() {
        return Ok(Value::Null);
    }
    Ok(serde_json::from_slice(&body).unwrap_or(Value::Null))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_disposition() {
        assert_eq!(
            content_disposition_filename("attachment; filename=\"Launch plan.docx\"").as_deref(),
            Some("Launch plan.docx")
        );
        assert_eq!(
            content_disposition_filename(
                "attachment; filename=\"x.md\"; filename*=UTF-8''Caf%C3%A9.md"
            )
            .as_deref(),
            Some("Café.md")
        );
        assert_eq!(content_disposition_filename("attachment").as_deref(), None);
    }

    #[test]
    fn urls_encode_segments() {
        let client = Client::new("http://127.0.0.1:4371/").unwrap();
        assert_eq!(
            client.url(&["v1", "docs", "d_a/b"]).as_str(),
            "http://127.0.0.1:4371/v1/docs/d_a%2Fb"
        );
        let prefixed = Client::new("https://example.test/api").unwrap();
        assert_eq!(
            prefixed.url(&["v1", "me"]).as_str(),
            "https://example.test/api/v1/me"
        );
    }

    #[test]
    fn rejects_bad_urls() {
        assert!(Client::new("not a url").is_err());
        assert!(Client::new("ftp://example.test").is_err());
    }
}
