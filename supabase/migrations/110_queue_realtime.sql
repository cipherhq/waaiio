-- Enable realtime for queue_entries so dashboard gets live updates
ALTER PUBLICATION supabase_realtime ADD TABLE queue_entries;
