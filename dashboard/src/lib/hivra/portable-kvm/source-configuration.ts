export const portableKvmSourceConfigurationPython = String.raw`
def source_fields(text):
    fields = {}
    for line in text.splitlines():
        if not line:
            continue
        key, sep, value = line.partition(": ")
        if not sep or not re.fullmatch(r"[a-z][a-z0-9_]*", key) or key in fields or not value:
            raise ValueError("invalid source configuration")
        fields[key] = value
    return fields

def source_configuration(raw, current, vmid, binding_tag, managed):
    sections = re.split(r"(?m)^\[special:cloudinit\]\n", raw, maxsplit=1)
    fields = source_fields(current)
    if source_fields(sections[0]) != fields:
        raise ValueError("source raw and current configurations differ")
    tags = fields.get("tags", "").split(";")
    if [tag for tag in tags if tag.startswith("hivra-bind-")] != [binding_tag]:
        raise ValueError("source binding changed")
    if managed:
        allocation = managed["allocationOperationId"]
        if [tag for tag in tags if tag.startswith("hivra-op-")] != ["hivra-op-" + allocation.replace("-", "")]:
            raise ValueError("source allocation changed")
        if "cicustom" in fields:
            raise ValueError("active source cloud-init override")
    if len(sections) == 2 and (not managed or sections[1].splitlines() != [
            "cicustom: vendor=local:snippets/hivra-qga-" + vmid + "-" + allocation + ".yaml"]):
        raise ValueError("unsupported source cloud-init cache")
    resources = managed.get("resources") if managed else None
    if resources and fields.get("memory") != str(resources["balloonMb"]):
        raise ValueError("source memory ceiling and floor differ")
    for key, name in (("balloon", "balloonMb"), ("cpuunits", "cpuUnits")):
        if resources:
            if fields.get(key) != str(resources[name]):
                raise ValueError("source resource envelope changed")
        elif key in fields:
            raise ValueError("unqualified source resource envelope")
    return fields
`;
