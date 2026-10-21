-- A recording starts as a private draft. Only its author can attach it to a comment.
-- Audio is kept with the database so document deletion and backups remain atomic.
create table comment_recordings (
    id text primary key,
    doc_id text not null references docs(id) on delete cascade,
    author_uuid text not null references accounts(uuid),
    audio bytea not null,
    content_type text not null,
    duration_ms bigint not null check (duration_ms between 1 and 180000),
    transcript text,
    transcription_attempts integer not null default 0,
    created_at timestamptz not null default now()
);
create index comment_recordings_author_created on comment_recordings(author_uuid, created_at);
alter table comments add column recording_id text references comment_recordings(id) on delete set null;
create unique index comments_recording on comments(recording_id) where recording_id is not null;
