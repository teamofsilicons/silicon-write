alter table comment_recordings drop constraint comment_recordings_duration_ms_check;
alter table comment_recordings add constraint comment_recordings_duration_ms_check check (duration_ms between 1 and 1800000);
create table comment_recording_uploads (
    id text primary key,
    doc_id text not null references docs(id) on delete cascade,
    author_uuid text not null references accounts(uuid),
    audio bytea not null check (octet_length(audio) <= 67108864),
    created_at timestamptz not null default now()
);
create index comment_recording_uploads_author_created on comment_recording_uploads(author_uuid, created_at);
