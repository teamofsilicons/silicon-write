alter table docs add column require_email boolean not null default false;
alter table docs add column email_gate_version bigint not null default 0;
create table doc_viewers (
    doc_id text not null references docs(id) on delete cascade,
    viewer_key text not null,
    email text not null,
    account_uuid text references accounts(uuid) on delete set null,
    email_source text not null check (email_source in ('account', 'entered')),
    first_viewed_at timestamptz not null default now(),
    last_viewed_at timestamptz not null default now(),
    primary key (doc_id, viewer_key)
);
create index doc_viewers_recent on doc_viewers(doc_id, last_viewed_at desc, viewer_key);
create table doc_view_grants (
    token_hash text primary key,
    doc_id text not null references docs(id) on delete cascade,
    email text not null,
    gate_version bigint not null,
    expires_at timestamptz not null default now() + interval '30 days'
);
create index doc_view_grants_doc on doc_view_grants(doc_id);
