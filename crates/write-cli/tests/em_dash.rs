//! Run the actual CLI against a local peer; no production accounts or documents.
use axum::{Json, Router, extract::State, routing::post};
use serde_json::{Value, json};
use std::{
    path::Path,
    process::Command,
    sync::{Arc, Mutex},
};

type Captures = Arc<Mutex<Vec<Value>>>;
async fn capture(State(bodies): State<Captures>, Json(body): Json<Value>) -> Json<Value> {
    bodies.lock().unwrap().push(body);
    Json(json!({"id":"d_test", "seq":2, "markdown":"Saved", "body":"Saved"}))
}
async fn cli(home: &Path, args: &[&str]) {
    let home = home.to_owned();
    let args: Vec<_> = args.iter().map(|a| a.to_string()).collect();
    let out = tokio::task::spawn_blocking(move || {
        Command::new(env!("CARGO_BIN_EXE_write"))
            .arg("--home")
            .arg(home)
            .arg("--json")
            .args(args)
            .env_remove("WRITE_API_URL")
            .env_remove("ACCOUNTS_URL")
            .output()
            .unwrap()
    })
    .await
    .unwrap();
    assert!(
        out.status.success(),
        "{} {}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}
#[tokio::test]
async fn silicon_rewrites_carbon_preserves_and_override_is_one_command() {
    let bodies: Captures = Default::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let api = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new()
        .route("/v1/docs", post(capture))
        .route("/v1/docs/d_test/edits", post(capture))
        .route("/v1/threads/t_test/comments", post(capture))
        .with_state(bodies.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    for kind in ["silicon", "carbon"] {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join(".write")).unwrap();
        std::fs::write(root.path().join(".write/session.json"), json!({
            "access_token":"test", "expires_at":4102444800_i64,
            "account":{"uuid":"test","id":if kind=="silicon" {"si:test"} else {"c:test"},"kind":kind},
            "api_url":api,"accounts_url":api,"method":"slt","signed_in_at":0
        }).to_string()).unwrap();
        let file = root.path().join("draft.md");
        std::fs::write(&file, "Draft—text – unchanged").unwrap();
        cli(
            root.path(),
            &[
                "new",
                "--title",
                "Title—one",
                "--file",
                file.to_str().unwrap(),
            ],
        )
        .await;
        cli(
            root.path(),
            &[
                "edit",
                "d_test",
                "--old",
                "Original—text",
                "--new",
                "New—text",
            ],
        )
        .await;
        cli(
            root.path(),
            &[
                "reply",
                "t_test",
                "--body",
                "Reply—one",
                "--dangerously-use-em-dash",
            ],
        )
        .await;
        cli(root.path(), &["reply", "t_test", "--body", "Reply—two"]).await;
        let b = std::mem::take(&mut *bodies.lock().unwrap());
        let dash = if kind == "silicon" { "-" } else { "—" };
        assert_eq!(b[0]["title"], format!("Title{dash}one"));
        assert_eq!(b[0]["markdown"], format!("Draft{dash}text – unchanged"));
        assert_eq!(b[1]["edits"][0]["old"], "Original—text");
        assert_eq!(b[1]["edits"][0]["new"], format!("New{dash}text"));
        assert_eq!(b[2]["body"], "Reply—one");
        assert_eq!(b[3]["body"], format!("Reply{dash}two"));
        assert_eq!(
            std::fs::read_to_string(file).unwrap(),
            "Draft—text – unchanged"
        );
    }
    server.abort();
}
