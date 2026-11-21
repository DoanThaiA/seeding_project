ALTER TYPE "CommentReplayStatus" ADD VALUE 'QUEUED';
ALTER TYPE "CommentReplayStatus" ADD VALUE 'SENDING';
ALTER TYPE "CommentReplayStatus" ADD VALUE 'FAILED';
ALTER TYPE "CommentReplayStatus" ADD VALUE 'UNKNOWN';

ALTER TABLE publication_comments
  ADD COLUMN send_version INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN send_detail TEXT;
