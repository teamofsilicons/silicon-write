-- Freeze sender attribution with each request so retries keep the same body.
alter table ting_outbox add column from_uuid text;

-- Only migrate requests known not to have been accepted. An uncertain old send
-- must be reconciled with Ting's sent history before changing its request body.
update ting_outbox set type = 'write.mentionReceived', from_uuid = data #>> '{by,uuid}'
where type = 'write.mention.received' and (attempts = 0 or (status = 'waiting' and last_error like '%no_subscription%')) and status in ('pending', 'waiting');
update ting_outbox set type = 'write.commentCreated', from_uuid = data #>> '{by,uuid}'
where type = 'write.comment.created' and (attempts = 0 or (status = 'waiting' and last_error like '%no_subscription%')) and status in ('pending', 'waiting');
update ting_outbox set type = 'write.commentReplied', from_uuid = data #>> '{by,uuid}'
where type = 'write.comment.replied' and (attempts = 0 or (status = 'waiting' and last_error like '%no_subscription%')) and status in ('pending', 'waiting');
update ting_outbox set type = 'write.threadResolved', from_uuid = data #>> '{by,uuid}'
where type = 'write.thread.resolved' and (attempts = 0 or (status = 'waiting' and last_error like '%no_subscription%')) and status in ('pending', 'waiting');
update ting_outbox set type = 'write.suggestionCreated', from_uuid = data #>> '{by,uuid}'
where type = 'write.suggestion.created' and (attempts = 0 or (status = 'waiting' and last_error like '%no_subscription%')) and status in ('pending', 'waiting');
update ting_outbox set type = 'write.docShared', from_uuid = data #>> '{by,uuid}'
where type = 'write.doc.shared' and (attempts = 0 or (status = 'waiting' and last_error like '%no_subscription%')) and status in ('pending', 'waiting');

update ting_outbox set status = 'failed',
    last_error = 'Legacy Ting request needs sent-history reconciliation before migration. Previous result: ' || coalesce(last_error, 'unknown')
where type in ('write.mention.received', 'write.comment.created', 'write.comment.replied',
               'write.thread.resolved', 'write.suggestion.created', 'write.doc.shared')
  and status in ('pending', 'waiting');
