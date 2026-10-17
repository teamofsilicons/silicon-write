-- Every verified email of an account (from its sign-ins), so inviting an email reaches an account
-- that already uses Silicon Write straight away.
alter table accounts add column emails text[] not null default '{}';
update accounts set emails = array[lower(email)] where email is not null and email <> '';
create index accounts_emails on accounts using gin (emails);

-- Which docs show which uploaded images. An image can be seen by anyone who can open a doc that
-- shows it, or ever showed it (old versions keep their images): a row is never removed while both
-- exist.
create table doc_assets (
    doc_id text not null references docs (id) on delete cascade,
    asset_id text not null references assets (id) on delete cascade,
    primary key (doc_id, asset_id)
);
create index doc_assets_asset on doc_assets (asset_id);
insert into doc_assets (doc_id, asset_id) select doc_id, id from assets where doc_id is not null on conflict do nothing;

-- A notification for someone who hasn't allowed Silicon Write at Ting yet waits for them.
create index ting_outbox_waiting on ting_outbox (for_uuid) where status = 'waiting';
