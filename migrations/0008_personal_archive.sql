-- Archive is personal organization, never a change to ownership or sharing.
create table archived_docs (
    account_uuid text not null references accounts(uuid) on delete cascade,
    doc_id text not null references docs(id) on delete cascade,
    archived_at timestamptz not null default now(),
    primary key (account_uuid, doc_id)
);
create table archived_folders (
    account_uuid text not null references accounts(uuid) on delete cascade,
    folder_id text not null references folders(id) on delete cascade,
    archived_at timestamptz not null default now(),
    primary key (account_uuid, folder_id)
);
