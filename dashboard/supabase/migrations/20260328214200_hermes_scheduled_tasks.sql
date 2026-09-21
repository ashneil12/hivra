-- Create hermes_scheduled_tasks table
CREATE TABLE IF NOT EXISTS hermes_scheduled_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR NOT NULL,
    name TEXT NOT NULL,
    schedule TEXT NOT NULL,
    command TEXT NOT NULL,
    agent_id UUID REFERENCES hermes_instances(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
-- RLS policies setup
ALTER TABLE hermes_scheduled_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view their own scheduled tasks" 
    ON hermes_scheduled_tasks FOR SELECT 
    USING (auth.uid()::text = user_id);
CREATE POLICY "Users can create their own scheduled tasks" 
    ON hermes_scheduled_tasks FOR INSERT 
    WITH CHECK (auth.uid()::text = user_id);
CREATE POLICY "Users can update their own scheduled tasks" 
    ON hermes_scheduled_tasks FOR UPDATE 
    USING (auth.uid()::text = user_id);
CREATE POLICY "Users can delete their own scheduled tasks" 
    ON hermes_scheduled_tasks FOR DELETE 
    USING (auth.uid()::text = user_id);
-- Create updated_at trigger function if it doesn't exist
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = timezone('utc'::text, now());
    RETURN NEW;
END;
$$ language 'plpgsql';
-- Add trigger for updated_at
CREATE TRIGGER update_hermes_scheduled_tasks_updated_at
    BEFORE UPDATE ON hermes_scheduled_tasks
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
