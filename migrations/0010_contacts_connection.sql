create table contact_connections (
    account_uuid text primary key references accounts(uuid) on delete cascade
);
