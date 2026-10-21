//! Silicon Write's service: the API behind the web editor and the `write` CLI (docs/api.md).

mod access;
mod accounts;
mod activity;
mod auth;
mod comments;
mod config;
mod content;
mod convert;
mod error;
mod events;
mod ids;
mod library;
mod live;
mod mail;
mod notify;
mod rooms;
mod service;
mod sharing;
mod state;
mod ting;
mod versions;
mod views;
mod voice;

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::routing::{delete, get, patch, post, put};
use silicon_accounts_client::AccountsClient;
use sqlx::postgres::PgPoolOptions;

use crate::config::Config;
use crate::state::{AppState, Inner};

fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(service::healthz))
        .route("/readyz", get(service::readyz))
        .route("/v1/me", get(library::me))
        .route("/v1/library", get(library::library))
        .route("/v1/docs", get(library::all_docs).post(library::new_doc))
        .route("/v1/docs/import", post(content::import_new))
        .route("/v1/docs/{id}", get(library::get_doc).patch(library::patch_doc).delete(library::trash_doc))
        .route("/v1/docs/{id}/restore", post(library::restore_doc))
        .route("/v1/docs/{id}/permanently", delete(library::purge_doc))
        .route("/v1/docs/{id}/copy", post(library::copy_doc))
        .route("/v1/docs/{id}/convert", post(content::convert_pdf))
        .route("/v1/docs/{id}/original", get(content::original))
        .route("/v1/docs/{id}/import", post(content::import_into))
        .route("/v1/docs/{id}/markdown", get(content::get_markdown).put(content::put_markdown))
        .route("/v1/docs/{id}/prosemirror", get(content::get_prosemirror))
        .route("/v1/docs/{id}/edits", post(content::post_edits))
        .route("/v1/docs/{id}/export", get(content::export))
        .route("/v1/docs/{id}/assets", post(content::upload_asset))
        .route("/v1/docs/{id}/backlinks", get(content::backlinks))
        .route("/v1/docs/{id}/authorship", get(content::authorship))
        .route("/v1/docs/{id}/live", post(live::ticket))
        .route("/v1/docs/{id}/context", get(events::context))
        .route("/v1/docs/{id}/events", get(events::watch))
        .route("/v1/docs/{id}/join", get(events::join))
        .route("/v1/docs/{id}/sharing", get(sharing::doc_members).post(sharing::share_doc))
        .route("/v1/docs/{id}/sharing/{member}", patch(sharing::change_doc_member).delete(sharing::remove_doc_member))
        .route("/v1/docs/{id}/public", put(sharing::set_public))
        .route("/v1/docs/{id}/transfer", post(library::transfer_doc))
        .route("/v1/docs/{id}/threads", get(comments::list).post(comments::create))
        .route("/v1/docs/{id}/recordings", post(voice::upload).layer(DefaultBodyLimit::max(3 * 1024 * 1024 + 16384)))
        .route("/v1/docs/{id}/recording-uploads", post(voice::begin_upload))
        .route("/v1/recording-uploads/{id}", put(voice::upload_part).delete(voice::cancel_upload).layer(DefaultBodyLimit::max(3 * 1024 * 1024)))
        .route("/v1/recording-uploads/{id}/finish", post(voice::finish_upload))
        .route("/v1/recordings/{id}", get(voice::audio))
        .route("/v1/recordings/{id}/transcribe", post(voice::transcribe))
        .route("/v1/docs/{id}/suggestions", get(versions::suggestions))
        .route("/v1/docs/{id}/suggestions/{action}", post(versions::decide_all))
        .route("/v1/docs/{id}/suggestions/{sid}/{action}", post(versions::decide))
        .route("/v1/docs/{id}/versions", get(versions::list))
        .route("/v1/docs/{id}/versions/{seq}/markdown", get(versions::version_markdown))
        .route("/v1/docs/{id}/versions/{seq}/name", put(versions::name_version).delete(versions::unname_version))
        .route("/v1/docs/{id}/compare", get(versions::compare))
        .route("/v1/docs/{id}/restore-version", post(versions::restore))
        .route("/v1/docs/{id}/undo", post(versions::undo_account))
        .route("/v1/docs/{id}/activity", get(activity::doc_activity))
        .route("/v1/links", get(content::resolve_link))
        .route("/v1/folders", get(library::all_folders).post(library::new_folder))
        .route("/v1/folders/{id}", get(library::get_folder).patch(library::patch_folder).delete(library::trash_folder))
        .route("/v1/folders/{id}/restore", post(library::restore_folder))
        .route("/v1/folders/{id}/permanently", delete(library::purge_folder))
        .route("/v1/folders/{id}/sharing", get(sharing::folder_members).post(sharing::share_folder))
        .route("/v1/folders/{id}/sharing/{member}", patch(sharing::change_folder_member).delete(sharing::remove_folder_member))
        .route("/v1/folders/{id}/transfer", post(library::transfer_folder))
        .route("/v1/folders/{id}/activity", get(activity::folder_activity))
        .route("/v1/transfers", get(library::transfers))
        .route("/v1/transfers/{id}/{action}", post(library::decide_transfer))
        .route("/v1/threads/{id}/comments", post(comments::reply))
        .route("/v1/threads/{id}/read", post(comments::mark_read))
        .route("/v1/threads/{id}/resolve", post(comments::resolve))
        .route("/v1/threads/{id}/reopen", post(comments::reopen))
        .route("/v1/comments/{id}", patch(comments::edit).delete(comments::delete))
        .route("/v1/comments/{id}/reactions", post(comments::react))
        .route("/v1/activity/{id}/undo", post(activity::undo))
        .route("/v1/search", get(content::search))
        .route("/v1/assets/{id}", get(content::get_asset))
        .route("/v1/live/{id}", get(live::connect))
        .route("/v1/webhooks/accounts", post(service::accounts_webhook))
        .route("/v1/dev/outbox", get(service::dev_outbox))
        .layer(DefaultBodyLimit::max(60 * 1024 * 1024))
        .layer(axum::middleware::map_response(error::plain_rejections))
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state)
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_env("WRITE_LOG").unwrap_or_else(|_| "info,sqlx=warn,tower_http=warn".into()))
        .init();
    let config = match Config::from_env() {
        Ok(c) => c,
        Err(problems) => {
            for p in problems {
                eprintln!("write-api: {p}");
            }
            std::process::exit(2);
        }
    };
    let db = PgPoolOptions::new()
        .max_connections(20)
        .acquire_timeout(Duration::from_secs(10))
        .connect(&config.database_url)
        .await
        .unwrap_or_else(|e| {
            eprintln!("write-api: can't reach the database: {e}");
            std::process::exit(1);
        });
    if let Err(e) = sqlx::migrate!("../../migrations").run(&db).await {
        eprintln!("write-api: migrating the database failed: {e}");
        std::process::exit(1);
    }
    let accounts = AccountsClient::builder()
        .base_url(config.accounts_url.clone())
        .allow_insecure_http(config.dev)
        .user_agent(format!("silicon-write/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .unwrap_or_else(|e| {
            eprintln!("write-api: the Silicon Accounts client couldn't start: {e}");
            std::process::exit(2);
        });
    tokio::fs::create_dir_all(config.data_dir.join("assets")).await.ok();
    let bind = config.bind.clone();
    let state = AppState(Arc::new(Inner {
        config,
        db,
        accounts,
        jwks: Default::default(),
        rooms: Default::default(),
        http: reqwest::Client::builder().timeout(Duration::from_secs(30)).build().expect("http client"),
        voice_slots: tokio::sync::Semaphore::new(2),
    }));
    tokio::spawn(ting::worker(state.clone()));
    tokio::spawn(mail::worker(state.clone()));
    {
        let state = state.clone();
        tokio::spawn(async move {
            loop {
                state.rooms.maintain(&state).await;
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        });
    }
    let listener = tokio::net::TcpListener::bind(&bind).await.unwrap_or_else(|e| {
        eprintln!("write-api: can't listen on {bind}: {e}");
        std::process::exit(1);
    });
    tracing::info!(%bind, "Silicon Write is listening");
    axum::serve(listener, router(state)).with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await
    .expect("server");
}
