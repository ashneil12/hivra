-- hermes_conversations profile routing
-- Add profile_name column to allow multiple agent profiles on one instance to each have their own chat history

ALTER TABLE hermes_conversations 
ADD COLUMN IF NOT EXISTS profile_name TEXT DEFAULT 'default';
-- Existing conversations default to 'default', so we don't need backfilling
-- Create an index to support fast filtering by profile_name
CREATE INDEX IF NOT EXISTS hermes_conversations_profile_idx 
ON hermes_conversations(instance_id, profile_name);
