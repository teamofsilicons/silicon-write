alter table shares add column group_key text, add column group_name text;
alter table shares drop constraint shares_check1;
alter table shares add constraint share_recipient check (num_nonnulls(account_uuid, email, group_key) = 1);
create unique index shares_doc_group on shares(doc_id, group_key) where doc_id is not null and group_key is not null;
create unique index shares_folder_group on shares(folder_id, group_key) where folder_id is not null and group_key is not null;
create table organization_settings (
    org_id text primary key,
    default_role text not null check (default_role in ('viewer','commenter','editor')),
    members_can_share boolean not null
);
