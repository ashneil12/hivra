-- Add branching support to conversations
alter table hermes_messages add column parent_id uuid references hermes_messages(id);
create index hermes_messages_parent_id_idx on hermes_messages(parent_id);
-- Migration script to stitch existing messages into a linear sequence per conversation
-- This is necessary to maintain backwards compatibility for existing conversations
DO $$
DECLARE
    conv record;
    msg record;
    prev_id uuid;
BEGIN
    FOR conv IN SELECT id FROM hermes_conversations LOOP
        prev_id := NULL;
        FOR msg IN (SELECT id FROM hermes_messages WHERE conversation_id = conv.id ORDER BY created_at ASC) LOOP
            IF prev_id IS NOT NULL THEN
                UPDATE hermes_messages SET parent_id = prev_id WHERE id = msg.id;
            END IF;
            prev_id := msg.id;
        END LOOP;
    END LOOP;
END $$;
