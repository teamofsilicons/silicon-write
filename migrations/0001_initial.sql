-- Silicon Write. Accounts are stored by their Silicon Accounts uuid; nothing is deleted except by an
-- owner permanently deleting from the trash.

create table accounts (
    uuid text primary key,
    kind text not null default 'carbon',
    public_id text not null default '',
    display_name text not null default '',
    pfp_url text not null default '',
    email text,
    refreshed_at timestamptz not null default now(),
    emails_checked_at timestamptz,
    ting_subscription text,
    ting_enrolled_at timestamptz,
    created_at timestamptz not null default now()
);
create index accounts_public_id on accounts (lower(public_id));

create table folders (
    id text primary key,
    owner_uuid text not null,
    parent_id text references folders (id),
    name text not null,
    created_by text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    deleted_at timestamptz,
    deleted_by text,
    -- Set when the folder went to the trash because a folder above it did.
    trashed_with text
);
create index folders_owner on folders (owner_uuid);
create index folders_parent on folders (parent_id);

create table docs (
    id text primary key,
    owner_uuid text not null,
    folder_id text references folders (id),
    title text not null default '',
    kind text not null default 'doc',
    created_by text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    deleted_at timestamptz,
    deleted_by text,
    trashed_with text,
    public_access text not null default 'none',
    seq bigint not null default 0,
    plain_text text not null default '',
    search tsvector,
    links text[] not null default '{}',
    original_asset text
);
create index docs_owner on docs (owner_uuid);
create index docs_folder on docs (folder_id);
create index docs_search on docs using gin (search);
create index docs_links on docs using gin (links);

create table shares (
    id text primary key,
    doc_id text references docs (id) on delete cascade,
    folder_id text references folders (id) on delete cascade,
    account_uuid text,
    email text,
    role text not null,
    invited_by text not null,
    created_at timestamptz not null default now(),
    check ((doc_id is null) <> (folder_id is null)),
    check ((account_uuid is null) <> (email is null))
);
create unique index shares_doc_account on shares (doc_id, account_uuid) where doc_id is not null and account_uuid is not null;
create unique index shares_folder_account on shares (folder_id, account_uuid) where folder_id is not null and account_uuid is not null;
create unique index shares_doc_email on shares (doc_id, lower(email)) where doc_id is not null and email is not null;
create unique index shares_folder_email on shares (folder_id, lower(email)) where folder_id is not null and email is not null;
create index shares_account on shares (account_uuid);
create index shares_email on shares (lower(email));

create table transfers (
    id text primary key,
    doc_id text references docs (id) on delete cascade,
    folder_id text references folders (id) on delete cascade,
    from_uuid text not null,
    to_uuid text not null,
    status text not null default 'pending',
    created_at timestamptz not null default now(),
    decided_at timestamptz
);

-- Every change to a doc, in order: the Yjs update its transaction made.
create table doc_updates (
    doc_id text not null references docs (id) on delete cascade,
    seq bigint not null,
    author_uuid text not null,
    origin text not null,
    update bytea not null,
    created_at timestamptz not null default now(),
    primary key (doc_id, seq)
);

-- The whole state at a point, so loading a doc doesn't replay everything.
create table doc_checkpoints (
    doc_id text not null references docs (id) on delete cascade,
    seq bigint not null,
    state bytea not null,
    created_at timestamptz not null default now(),
    primary key (doc_id, seq)
);

-- Which account each Yjs client id belongs to (who wrote what).
create table doc_clients (
    doc_id text not null references docs (id) on delete cascade,
    client_id bigint not null,
    author_uuid text not null,
    created_at timestamptz not null default now(),
    primary key (doc_id, client_id)
);

create table version_names (
    doc_id text not null references docs (id) on delete cascade,
    seq bigint not null,
    name text not null,
    created_by text not null,
    created_at timestamptz not null default now(),
    primary key (doc_id, seq)
);

create table threads (
    id text primary key,
    doc_id text not null references docs (id) on delete cascade,
    anchor jsonb not null,
    quote text not null default '',
    status text not null default 'open',
    created_by text not null,
    created_at timestamptz not null default now(),
    resolved_by text,
    resolved_at timestamptz
);
create index threads_doc on threads (doc_id);

create table comments (
    id text primary key,
    thread_id text not null references threads (id) on delete cascade,
    doc_id text not null references docs (id) on delete cascade,
    author_uuid text not null,
    body text not null,
    created_at timestamptz not null default now(),
    edited_at timestamptz,
    deleted_at timestamptz
);
create index comments_thread on comments (thread_id);

-- Earlier text of edited comments.
create table comment_revisions (
    comment_id text not null references comments (id) on delete cascade,
    body text not null,
    replaced_at timestamptz not null default now()
);

create table reactions (
    comment_id text not null references comments (id) on delete cascade,
    account_uuid text not null,
    emoji text not null,
    created_at timestamptz not null default now(),
    primary key (comment_id, account_uuid, emoji)
);

-- Suggestions seen in a doc (their text lives in the doc itself).
create table suggestions (
    doc_id text not null references docs (id) on delete cascade,
    id text not null,
    author_uuid text not null,
    first_seen_at timestamptz not null default now(),
    resolution text,
    resolved_by text,
    resolved_at timestamptz,
    primary key (doc_id, id)
);

create table assets (
    id text primary key,
    doc_id text references docs (id) on delete cascade,
    owner_uuid text not null,
    content_type text not null,
    filename text not null default '',
    size bigint not null,
    path text not null,
    created_at timestamptz not null default now()
);

create table activity (
    id bigserial primary key,
    doc_id text references docs (id) on delete cascade,
    folder_id text references folders (id) on delete cascade,
    actor_uuid text not null,
    kind text not null,
    data jsonb not null default '{}',
    created_at timestamptz not null default now(),
    undone_at timestamptz
);
create index activity_doc on activity (doc_id, id);
create index activity_folder on activity (folder_id, id);

create table ting_outbox (
    id bigserial primary key,
    type text not null,
    for_uuid text not null,
    key text not null unique,
    data jsonb not null,
    status text not null default 'pending',
    attempts int not null default 0,
    next_at timestamptz not null default now(),
    last_error text,
    created_at timestamptz not null default now(),
    sent_at timestamptz
);
create index ting_outbox_pending on ting_outbox (next_at) where status = 'pending';

create table email_outbox (
    id bigserial primary key,
    to_email text not null,
    subject text not null,
    text_body text not null,
    status text not null default 'pending',
    attempts int not null default 0,
    last_error text,
    created_at timestamptz not null default now(),
    sent_at timestamptz
);
