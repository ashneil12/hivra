import { HOST_DISCOVERY_PROTOCOL, HOST_ISOLATION_ENGINE_IDS } from "../host-discovery-contracts";

export function guestDiscoveryOutput(overrides:Record<string,string>={}) {
  const b64=(value:string)=>Buffer.from(value).toString("base64");
  const values:Record<string,string>={PROTOCOL:"1",OS_FAMILY:"linux",OS_ID_B64:b64("ubuntu"),OS_VERSION_ID_B64:b64("22.04"),
    KERNEL_RELEASE_B64:b64("5.15.0-generic"),ARCH_B64:b64("x86_64"),EUID:"0",VIRTUALIZATION:"virtual-machine",CGROUP_VERSION:"2",
    CPU_LOGICAL_CORES:"2",MEMORY_TOTAL_BYTES:"4000000000",MEMORY_AVAILABLE_BYTES:"3500000000",
    ROOT_STORAGE_TOTAL_BYTES:"40000000000",ROOT_STORAGE_AVAILABLE_BYTES:"35000000000",
    KVM_DEVICE:"0",CPU_VIRTUALIZATION:"0",PACKAGE_MANAGERS:"apt",MACHINE_ID_DIGEST:"c".repeat(64)};
  for(const engine of HOST_ISOLATION_ENGINE_IDS){
    const prefix=engine.replaceAll("-","_").toUpperCase();
    values[prefix+"_INSTALLED"]="0";values[prefix+"_VERSION_B64"]="";
  }
  return Object.entries({...values,END:"1",...overrides}).map(([key,value])=>`${HOST_DISCOVERY_PROTOCOL}\t${key}\t${value}`).join("\n");
}
