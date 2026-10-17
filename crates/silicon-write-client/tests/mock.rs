//! The client against a small in-process mock of the API.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::Json;
use axum::Router;
use axum::extract::{Multipart, Path, Query};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::{get, post, put};
use futures::future::BoxFuture;
use serde_json::{Value, json};
use silicon_write_client::*;

async fn serve(router: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    format!("http://{addr}")
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .map(str::to_owned)
}

fn unauthorized() -> axum::response::Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": { "code": "unauthorized", "message": "The access token expired.", "hint": "Refresh it." } })),
    )
        .into_response()
}

struct Rotating {
    refreshes: AtomicUsize,
}

impl TokenProvider for Rotating {
    fn token(&self) -> BoxFuture<'_, Result<Option<String>>> {
        Box::pin(async { Ok(Some("old".to_owned())) })
    }
    fn refresh<'a>(&'a self, rejected: &'a str) -> BoxFuture<'a, Result<Option<String>>> {
        Box::pin(async move {
            assert_eq!(rejected, "old");
            self.refreshes.fetch_add(1, Ordering::SeqCst);
            Ok(Some("fresh".to_owned()))
        })
    }
}

#[tokio::test]
async fn refreshes_once_after_a_401_and_retries() {
    let router = Router::new().route(
        "/v1/me",
        get(|headers: HeaderMap| async move {
            if bearer(&headers).as_deref() == Some("fresh") {
                Json(json!({ "account": { "uuid": "u1", "id": "si:writer", "kind": "silicon", "display_name": "Writer" } }))
                    .into_response()
            } else {
                unauthorized()
            }
        }),
    );
    let base = serve(router).await;
    let provider = Arc::new(Rotating {
        refreshes: AtomicUsize::new(0),
    });
    let client = Client::new(&base)
        .unwrap()
        .with_token_provider(provider.clone());
    let me = client.me().await.unwrap();
    assert_eq!(me.id, "si:writer");
    assert_eq!(provider.refreshes.load(Ordering::SeqCst), 1);

    // A static token gets the API's error as it is.
    let err = Client::new(&base)
        .unwrap()
        .with_token("bad")
        .me()
        .await
        .unwrap_err();
    assert!(err.is_unauthorized());
    assert_eq!(err.hint(), Some("Refresh it."));
    assert_eq!(err.to_json()["error"]["code"], "unauthorized");
}

#[tokio::test]
async fn edits_imports_and_downloads() {
    let router = Router::new()
        .route(
            "/v1/docs/{id}/edits",
            post(|Path(id): Path<String>, Json(body): Json<Value>| async move {
                assert_eq!(id, "d_1");
                let edits = body["edits"].as_array().unwrap();
                if edits[0]["old"] == "missing" {
                    return (
                        StatusCode::UNPROCESSABLE_ENTITY,
                        Json(json!({ "error": { "code": "no_match", "message": "“missing” is not in the doc.", "hint": "Read it with write cat." } })),
                    )
                        .into_response();
                }
                assert_eq!(body["suggest"], true);
                Json(json!({ "seq": 7, "markdown": "new text\n" })).into_response()
            }),
        )
        .route(
            "/v1/docs/import",
            post(|mut multipart: Multipart| async move {
                let mut file = None;
                let mut title = None;
                while let Some(field) = multipart.next_field().await.unwrap() {
                    match field.name().unwrap() {
                        "file" => {
                            let name = field.file_name().unwrap().to_owned();
                            let ct = field.content_type().unwrap().to_owned();
                            file = Some((name, ct, field.bytes().await.unwrap()));
                        }
                        "title" => title = Some(field.text().await.unwrap()),
                        _ => {}
                    }
                }
                let (name, ct, bytes) = file.unwrap();
                assert_eq!(name, "notes.md");
                assert_eq!(ct, "text/markdown");
                assert_eq!(&bytes[..], b"# Notes\n");
                (StatusCode::CREATED, Json(json!({ "id": "d_2", "title": title.unwrap(), "seq": 1 })))
            }),
        )
        .route(
            "/v1/docs/{id}/export",
            get(|Query(q): Query<std::collections::HashMap<String, String>>| async move {
                assert_eq!(q.get("format").map(String::as_str), Some("docx"));
                assert_eq!(q.get("seq").map(String::as_str), Some("3"));
                (
                    [(header::CONTENT_DISPOSITION, "attachment; filename=\"Plan.docx\""), (header::CONTENT_TYPE, "application/octet-stream")],
                    vec![7u8; 100_000],
                )
            }),
        )
        .route(
            "/v1/docs/{id}/markdown",
            put(|Json(body): Json<Value>| async move {
                assert_eq!(body["base_seq"], 4);
                Json(json!({ "seq": 9, "markdown": body["markdown"] }))
            }),
        );
    let base = serve(router).await;
    let client = Client::new(&base).unwrap().with_token("t");

    let result = client
        .edit("d_1", &[Edit::new("old", "new")], true)
        .await
        .unwrap();
    assert_eq!(result.seq, 7);
    let err = client
        .edit("d_1", &[Edit::new("missing", "x")], false)
        .await
        .unwrap_err();
    assert_eq!(err.code(), "no_match");
    assert_eq!(err.status(), Some(422));

    let doc = client
        .import_doc(&Upload::new("notes.md", "# Notes\n"), None, Some("Notes"))
        .await
        .unwrap();
    assert_eq!(doc.id, "d_2");
    assert_eq!(doc.title, "Notes");

    let download = client
        .export("d_1", ExportFormat::Docx, Some(3))
        .await
        .unwrap();
    assert_eq!(download.file_name.as_deref(), Some("Plan.docx"));
    let mut out = Vec::new();
    let written = download.write_to(&mut out).await.unwrap();
    assert_eq!(written, 100_000);

    let put = client
        .put_markdown("d_1", "hello\n", Some(4), false)
        .await
        .unwrap();
    assert_eq!((put.seq, put.markdown.as_str()), (9, "hello\n"));
}

#[tokio::test]
async fn network_errors_say_what_to_do() {
    let client = Client::new("http://127.0.0.1:9").unwrap();
    let err = client.healthz().await.unwrap_err();
    assert!(err.is_network());
    assert!(err.hint().unwrap().contains("healthz"));
}
