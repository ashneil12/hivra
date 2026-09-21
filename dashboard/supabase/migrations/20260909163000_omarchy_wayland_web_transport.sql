-- Admit the browser transport on Wayland only after the capability inspector
-- has recorded that exact Selkies transport for the computer revision.
do $migration$
declare
  signature regprocedure := 'public.issue_hivra_remote_desktop_session_v2(text,uuid,text,uuid,text,text,text,text,text,timestamptz,timestamptz,timestamptz,text)'::regprocedure;
  definition text;
  anchor text := 'if (p_transport in (''selkies-webrtc'',''selkies-websocket'') and c.compositor<>''x11'')
    or (p_transport=''sunshine-moonlight'' and not c.private_network_reachable) then';
  replacement text := 'if (p_transport=''selkies-webrtc'' and c.compositor<>''x11'')
    or (p_transport=''selkies-websocket'' and c.compositor not in (''x11'',''wayland''))
    or (p_transport=''sunshine-moonlight'' and not c.private_network_reachable) then';
begin
  definition := pg_get_functiondef(signature);
  if position(replacement in definition) > 0 and position(anchor in definition) = 0 then
    return;
  end if;
  if (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 then
    raise exception 'Omarchy Wayland browser transport anchor mismatch';
  end if;
  execute replace(definition,anchor,replacement);
end;
$migration$;
