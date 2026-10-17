-- Comment activity is separate from document text versions. Each account acknowledges
-- only the thread revision it actually saw; another account's newer activity stays unread.
alter table threads add column activity_version bigint not null default 1 check (activity_version >= 1);

-- Keeping each actor's latest activity is enough to distinguish new activity from
-- others without treating one's own reply as having read earlier replies.
create table thread_activity (
    thread_id text not null references threads (id) on delete cascade,
    account_uuid text not null,
    activity_version bigint not null check (activity_version >= 1),
    primary key (thread_id, account_uuid)
);

create table thread_reads (
    thread_id text not null references threads (id) on delete cascade,
    account_uuid text not null,
    read_version bigint not null check (read_version >= 0),
    read_at timestamptz not null default now(),
    primary key (thread_id, account_uuid)
);

-- Earlier read history was not recorded. Existing participants' activity is
-- available at revision 1, and is acknowledged when each reader opens the thread.
insert into thread_activity (thread_id, account_uuid, activity_version)
select id, created_by, 1 from threads
union select thread_id, author_uuid, 1 from comments
union select c.thread_id, r.account_uuid, 1 from reactions r join comments c on c.id = r.comment_id
union select id, resolved_by, 1 from threads where resolved_by is not null;
