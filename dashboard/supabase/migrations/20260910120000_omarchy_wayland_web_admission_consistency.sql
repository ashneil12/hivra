-- The Wayland browser transport was admitted at session issue only. The
-- exchange, authorize and renewal RPCs still carried the original X11-only
-- Selkies gate, so a Wayland session was issued successfully and then rejected
-- on the very next call: exchange returned capability_unavailable, the control
-- plane surfaced 409, and the guest broker reported the handoff as rejected.
--
-- Apply the same admission rule to every remaining RPC that enforces it, and
-- change nothing else: selkies-webrtc stays X11-only, and sunshine-moonlight
-- still requires proven private-network reachability.
--
-- Each block is idempotent. A block that finds its replacement already present
-- returns without touching the function; a block that cannot find its anchor
-- exactly once raises rather than silently leaving admission inconsistent.

-- exchange: the browser's first control call. This is the call the failing
-- handoff never completed (exchanged_at stayed null).
do $migration$
declare
  signature regprocedure := 'public.exchange_hivra_remote_desktop_session(text,text,text)'::regprocedure;
  definition text;
  anchor text := 'if (s.transport in (''selkies-webrtc'',''selkies-websocket'') and c.compositor<>''x11'')
    or (s.transport=''sunshine-moonlight'' and not c.private_network_reachable) then';
  replacement text := 'if (s.transport=''selkies-webrtc'' and c.compositor<>''x11'')
    or (s.transport=''selkies-websocket'' and c.compositor not in (''x11'',''wayland''))
    or (s.transport=''sunshine-moonlight'' and not c.private_network_reachable) then';
begin
  definition := pg_get_functiondef(signature);
  if position(replacement in definition) > 0 and position(anchor in definition) = 0 then
    return;
  end if;
  if (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 then
    raise exception 'Omarchy Wayland exchange admission anchor mismatch';
  end if;
  execute replace(definition,anchor,replacement);
end;
$migration$;

-- authorize: re-proves the transport on every media request. Without this the
-- handoff would exchange and then immediately fail its first authorization.
do $migration$
declare
  signature regprocedure := 'public.authorize_hivra_remote_desktop_session(text,text,uuid,text,boolean)'::regprocedure;
  definition text;
  anchor text := 'if (s.transport in (''selkies-webrtc'',''selkies-websocket'') and c.compositor<>''x11'')
    or (s.transport=''sunshine-moonlight'' and not c.private_network_reachable) then';
  replacement text := 'if (s.transport=''selkies-webrtc'' and c.compositor<>''x11'')
    or (s.transport=''selkies-websocket'' and c.compositor not in (''x11'',''wayland''))
    or (s.transport=''sunshine-moonlight'' and not c.private_network_reachable) then';
begin
  definition := pg_get_functiondef(signature);
  if position(replacement in definition) > 0 and position(anchor in definition) = 0 then
    return;
  end if;
  if (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 then
    raise exception 'Omarchy Wayland authorize admission anchor mismatch';
  end if;
  execute replace(definition,anchor,replacement);
end;
$migration$;

-- renew: only ever runs for an already-exchanged selkies-websocket session, so
-- its gate is the bare compositor conjunct inside a wider boolean. Widen that
-- one conjunct and leave the surrounding conditions untouched.
do $migration$
declare
  signature regprocedure := 'public.renew_hivra_remote_desktop_session_by_token(text,integer)'::regprocedure;
  definition text;
  anchor text := 'or c.compositor<>''x11''';
  replacement text := 'or c.compositor not in (''x11'',''wayland'')';
begin
  definition := pg_get_functiondef(signature);
  if position(replacement in definition) > 0 and position(anchor in definition) = 0 then
    return;
  end if;
  if (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 then
    raise exception 'Omarchy Wayland renewal admission anchor mismatch';
  end if;
  execute replace(definition,anchor,replacement);
end;
$migration$;
