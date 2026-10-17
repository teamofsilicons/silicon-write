-- An uploaded image stays while any doc shows it, or once showed it (doc_assets), or opens it as
-- its PDF: a copy keeps its images after the doc they were uploaded to is deleted for good.
-- `assets.doc_id` is the doc that uploaded it, and empty once that doc is gone. Deleting a doc for
-- good only removes the files no remaining doc refers to.
alter table assets drop constraint assets_doc_id_fkey;
alter table assets add constraint assets_doc_id_fkey foreign key (doc_id) references docs (id) on delete set null;
create index assets_doc on assets (doc_id);
create index docs_original_asset on docs (original_asset) where original_asset is not null;

-- One change can be shown in several histories (a move is in the doc's history and in the
-- folders it left and joined): every row of it shares a change id, and undoing it from any of
-- them undoes it in all of them. A row recorded on its own is a change of its own.
create sequence activity_change_seq;
alter table activity add column change_id bigint not null default nextval('activity_change_seq');
alter sequence activity_change_seq owned by activity.change_id;
create index activity_change on activity (change_id);

-- The doc or folder a change is about, which isn't always the one whose history shows it (a doc
-- moving through a folder, a subfolder made inside one): deleting it for good takes every row
-- about it along, so nothing about it is left in any history.
alter table activity add column about_doc text references docs (id) on delete cascade;
alter table activity add column about_folder text references folders (id) on delete cascade;
create index activity_about_doc on activity (about_doc) where about_doc is not null;
create index activity_about_folder on activity (about_folder) where about_folder is not null;

-- Rows already kept about docs and folders that were deleted for good go now, and the rest learn
-- what they're about.
delete from activity
 where kind like 'doc.%' and jsonb_typeof(data -> 'doc') = 'string'
   and not exists (select 1 from docs where id = activity.data ->> 'doc');
delete from activity
 where kind like 'folder.%' and jsonb_typeof(data -> 'folder') = 'string'
   and not exists (select 1 from folders where id = activity.data ->> 'folder');
update activity set about_doc = data ->> 'doc' where kind like 'doc.%' and jsonb_typeof(data -> 'doc') = 'string';
update activity set about_folder = data ->> 'folder' where kind like 'folder.%' and jsonb_typeof(data -> 'folder') = 'string';
