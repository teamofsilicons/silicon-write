//! Private voice-comment drafts and server-side Deepgram transcription.
use crate::{
    access::{self, Role},
    auth::{Auth, Caller},
    error::{ApiError, ApiResult},
    ids,
    state::AppState,
};
use axum::{
    Json,
    body::Body,
    extract::{Multipart, Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::{io::Write, time::Duration};

const MAX_BYTES: usize = 3 * 1024 * 1024;
const MAX_PCM: usize = 180 * 16000 * 2;

fn media_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x1a\x45\xdf\xa3") {
        Some("audio/webm")
    } else if bytes.get(4..8) == Some(b"ftyp") {
        Some("audio/mp4")
    } else if bytes.starts_with(b"OggS") {
        Some("audio/ogg")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WAVE") {
        Some("audio/wav")
    } else {
        None
    }
}

/// Decode a bounded amount of actual audio before making a paid provider request.
async fn normalize(state: &AppState, bytes: &[u8]) -> ApiResult<Vec<u8>> {
    let directory = tempfile::tempdir().map_err(ApiError::internal)?;
    let mut input =
        tempfile::NamedTempFile::new_in(directory.path()).map_err(ApiError::internal)?;
    input.write_all(bytes).map_err(ApiError::internal)?;
    let mut command = tokio::process::Command::new(&state.config.ffmpeg);
    command
        .current_dir(directory.path())
        .env_clear()
        .args([
            "-nostdin",
            "-v",
            "error",
            "-threads",
            "1",
            "-protocol_whitelist",
            "file,pipe",
            "-i",
        ])
        .arg(input.path())
        .args([
            "-map", "0:a:0", "-t", "181", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1",
        ])
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(20), command.output())
        .await
        .map_err(|_| {
            ApiError::invalid("The recording took too long to read. Record a shorter comment.")
        })?
        .map_err(|_| {
            ApiError::unavailable("Voice recording isn't available on this server yet.")
        })?;
    if !output.status.success() || output.stdout.is_empty() {
        return Err(ApiError::invalid(
            "This file doesn't contain a readable audio recording.",
        ));
    }
    if output.stdout.len() > MAX_PCM {
        return Err(ApiError::invalid(
            "Voice comments can be up to 3 minutes long.",
        ));
    }
    Ok(output.stdout)
}

/// A seekable, consistently playable WAV with a real duration, including Safari.
fn wave(pcm: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(44 + pcm.len());
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + pcm.len() as u32).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&16000u32.to_le_bytes());
    bytes.extend_from_slice(&32000u32.to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
    bytes.extend_from_slice(pcm);
    bytes
}

fn busy() -> ApiError {
    ApiError::new(
        StatusCode::TOO_MANY_REQUESTS,
        "voice_busy",
        "Voice processing is busy. Try again in a moment.",
    )
}

pub async fn upload(
    State(state): State<AppState>,
    Auth(caller): Auth,
    Path(doc_id): Path<String>,
    mut multipart: Multipart,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let (doc, _) = access::require_doc(&state, Some(&caller), &doc_id, Role::Commenter).await?;
    if doc.deleted_at.is_some() {
        return Err(ApiError::conflict(
            "Restore this doc before adding a voice comment.",
        ));
    }
    let _permit = state.voice_slots.try_acquire().map_err(|_| busy())?;
    let mut bytes = Vec::new();
    let mut seen = false;
    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|_| ApiError::invalid("The recording upload couldn't be read."))?
    {
        if field.name() != Some("audio") || seen {
            return Err(ApiError::invalid("Upload exactly one audio field."));
        }
        seen = true;
        while let Some(chunk) = field
            .chunk()
            .await
            .map_err(|_| ApiError::invalid("The recording upload couldn't be read."))?
        {
            if bytes.len() + chunk.len() > MAX_BYTES {
                return Err(ApiError::new(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "too_large",
                    "Recordings can be at most 3 MiB. Try a shorter comment.",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
    }
    media_type(&bytes)
        .ok_or_else(|| ApiError::invalid("Use a WebM, MP4, Ogg or WAV audio recording."))?;
    let pcm = normalize(&state, &bytes).await?;
    let duration_ms = (pcm.len() as i64 * 1000 / 32000).max(1);
    let mut tx = state.db.begin().await?;
    sqlx::query("select pg_advisory_xact_lock(hashtextextended($1, 71))")
        .bind(&caller.uuid)
        .execute(&mut *tx)
        .await?;
    let recent: i64 = sqlx::query_scalar("select count(*) from comment_recordings where author_uuid=$1 and created_at > now() - interval '1 hour'").bind(&caller.uuid).fetch_one(&mut *tx).await?;
    if recent >= 60 {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "voice_limit",
            "You've recorded 60 voice comments in the last hour. Try again later.",
        ));
    }
    sqlx::query("delete from comment_recordings r where r.author_uuid=$1 and r.created_at < now() - interval '7 days' and not exists (select 1 from comments c where c.recording_id=r.id)").bind(&caller.uuid).execute(&mut *tx).await?;
    let id = ids::new_id("r");
    sqlx::query("insert into comment_recordings(id, doc_id, author_uuid, audio, content_type, duration_ms) values($1,$2,$3,$4,$5,$6)")
        .bind(&id).bind(&doc_id).bind(&caller.uuid).bind(wave(&pcm)).bind("audio/wav").bind(duration_ms).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({"id":id,"duration_ms":duration_ms,"transcript":null})),
    ))
}

pub async fn transcribe(
    State(state): State<AppState>,
    Auth(caller): Auth,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let row: Option<(String, String, Option<String>)> = sqlx::query_as(
        "select doc_id, author_uuid, transcript from comment_recordings where id=$1",
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;
    let (doc_id, author, transcript) = row.ok_or_else(|| ApiError::not_found("This recording"))?;
    let (doc, _) = access::require_doc(&state, Some(&caller), &doc_id, Role::Commenter).await?;
    if author != caller.uuid {
        return Err(ApiError::not_found("This recording"));
    }
    if doc.deleted_at.is_some() {
        return Err(ApiError::conflict("Restore this doc before transcribing."));
    }
    if let Some(transcript) = transcript {
        return Ok(Json(json!({"transcript":transcript})));
    }
    let key = state.config.deepgram_api_key.as_ref().ok_or_else(|| {
        ApiError::unavailable(
            "Transcription isn't configured yet. Your recording is saved; try again later.",
        )
    })?;
    let _permit = state.voice_slots.try_acquire().map_err(|_| busy())?;
    let mut tx = state.db.begin().await?;
    // Serialize retries for this recording, then cache the result. No duplicate concurrent provider calls.
    let row: (Option<String>, i32, Vec<u8>) = sqlx::query_as("select transcript, transcription_attempts, audio from comment_recordings where id=$1 for update").bind(&id).fetch_one(&mut *tx).await?;
    if let Some(transcript) = row.0 {
        return Ok(Json(json!({"transcript":transcript})));
    }
    if row.1 >= 5 {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "transcription_limit",
            "Transcription couldn't finish after five attempts. You can still post the recording and type its transcript.",
        ));
    }
    let pcm = normalize(&state, &row.2).await?;
    sqlx::query(
        "update comment_recordings set transcription_attempts=transcription_attempts+1 where id=$1",
    )
    .bind(&id)
    .execute(&mut *tx)
    .await?;
    let result = async {
        let mut response = state
            .http
            .post(&state.config.deepgram_url)
            .query(&[
                ("model", "nova-3"),
                ("language", "multi"),
                ("smart_format", "true"),
                ("mip_opt_out", "true"),
                ("encoding", "linear16"),
                ("sample_rate", "16000"),
                ("channels", "1"),
            ])
            .header(header::AUTHORIZATION, format!("Token {key}"))
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .timeout(Duration::from_secs(90))
            .body(pcm)
            .send()
            .await
            .map_err(|_| {
                ApiError::unavailable(
                    "Transcription didn't finish. Your recording is saved; try again.",
                )
            })?;
        if !response.status().is_success() {
            return Err(ApiError::unavailable(
                "Transcription is temporarily unavailable. Your recording is saved; try again.",
            ));
        }
        let mut data = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| ApiError::unavailable("The transcript couldn't be read. Try again."))?
        {
            if data.len() + chunk.len() > 1024 * 1024 {
                return Err(ApiError::unavailable(
                    "The transcription response was too large.",
                ));
            }
            data.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&data)
            .map_err(|_| ApiError::unavailable("The transcript couldn't be read. Try again."))?;
        let text = value
            .pointer("/results/channels/0/alternatives/0/transcript")
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::unavailable("The transcription response was incomplete."))?
            .trim();
        if text.chars().count() > 20000 || text.contains('\0') {
            return Err(ApiError::unavailable(
                "The transcript was too long. You can type a shorter transcript.",
            ));
        }
        Ok::<String, ApiError>(text.to_owned())
    }
    .await;
    if let Ok(text) = &result {
        sqlx::query("update comment_recordings set transcript=$2 where id=$1")
            .bind(&id)
            .bind(text)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(Json(json!({"transcript":result?})))
}

/// Checked under the same transaction as posting, including author and document binding.
pub async fn attach(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: Option<&str>,
    doc_id: &str,
    caller: &Caller,
) -> ApiResult<()> {
    let Some(id) = id else {
        return Ok(());
    };
    let found: Option<(String, String)> =
        sqlx::query_as("select doc_id,author_uuid from comment_recordings where id=$1 for update")
            .bind(id)
            .fetch_optional(&mut **tx)
            .await?;
    if found
        .as_ref()
        .is_none_or(|(d, a)| d != doc_id || a != &caller.uuid)
    {
        return Err(ApiError::not_found("This recording"));
    }
    let used: bool =
        sqlx::query_scalar("select exists(select 1 from comments where recording_id=$1)")
            .bind(id)
            .fetch_one(&mut **tx)
            .await?;
    if used {
        return Err(ApiError::conflict(
            "This recording is already attached to a comment.",
        ));
    }
    Ok(())
}

fn byte_range(range: Option<&str>, size: usize) -> Result<(usize, usize, bool), ()> {
    let Some(range) = range else {
        return Ok((0, size - 1, false));
    };
    let value = range.strip_prefix("bytes=").ok_or(())?;
    let (start, end) = value.split_once('-').ok_or(())?;
    if start.is_empty() {
        let suffix = end.parse::<usize>().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        return Ok((size.saturating_sub(suffix), size - 1, true));
    }
    let start = start.parse::<usize>().map_err(|_| ())?;
    let end = if end.is_empty() {
        size - 1
    } else {
        end.parse::<usize>().map_err(|_| ())?.min(size - 1)
    };
    if start >= size || start > end {
        return Err(());
    }
    Ok((start, end, true))
}

pub async fn audio(
    State(state): State<AppState>,
    Auth(caller): Auth,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let row: Option<(String,String,String,Option<bool>)>=sqlx::query_as("select r.doc_id,r.author_uuid,r.content_type,(select c.deleted_at is null from comments c where c.recording_id=r.id) from comment_recordings r where r.id=$1").bind(&id).fetch_optional(&state.db).await?;
    let (doc_id, author, mime, published) =
        row.ok_or_else(|| ApiError::not_found("This recording"))?;
    access::require_doc(&state, Some(&caller), &doc_id, Role::Commenter).await?;
    if published == Some(false) || (published.is_none() && author != caller.uuid) {
        return Err(ApiError::not_found("This recording"));
    }
    let bytes: Vec<u8> = sqlx::query_scalar("select audio from comment_recordings where id=$1")
        .bind(&id)
        .fetch_one(&state.db)
        .await?;
    let size = bytes.len();
    let Ok((start, end, partial)) = byte_range(
        headers.get(header::RANGE).and_then(|h| h.to_str().ok()),
        size,
    ) else {
        return Ok((
            StatusCode::RANGE_NOT_SATISFIABLE,
            [(header::CONTENT_RANGE, format!("bytes */{size}"))],
        )
            .into_response());
    };
    let mut response = Response::new(Body::from(bytes[start..=end].to_vec()));
    *response.status_mut() = if partial {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    for (name, value) in [
        (header::CONTENT_TYPE, mime),
        (header::CONTENT_LENGTH, (end - start + 1).to_string()),
        (header::ACCEPT_RANGES, "bytes".into()),
        (header::CACHE_CONTROL, "private, no-store".into()),
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff".into()),
    ] {
        response
            .headers_mut()
            .insert(name, value.parse().map_err(ApiError::internal)?);
    }
    if partial {
        response.headers_mut().insert(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{size}")
                .parse()
                .map_err(ApiError::internal)?,
        );
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn byte_ranges_are_bounded() {
        assert_eq!(byte_range(Some("bytes=2-99"), 10), Ok((2, 9, true)));
        assert_eq!(byte_range(Some("bytes=-3"), 10), Ok((7, 9, true)));
        assert_eq!(byte_range(Some("bytes=10-"), 10), Err(()));
        assert_eq!(byte_range(Some("bytes=2-3,5-6"), 10), Err(()));
    }
    #[test]
    fn type_comes_from_media_bytes() {
        assert_eq!(media_type(b"RIFFxxxxWAVE"), Some("audio/wav"));
        assert_eq!(media_type(b"<script>audio</script>"), None);
    }
}
