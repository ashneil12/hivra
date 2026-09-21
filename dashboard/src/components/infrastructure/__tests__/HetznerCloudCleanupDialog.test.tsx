/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HetznerCloudCleanupDialog } from "../HetznerCloudCleanupDialog";
import { advanceCleanup, forgetCleanupAccess, listCleanupOrders, previewCleanup, type HetznerCleanupView } from "@/lib/infrastructure/hetzner-cleanup-client";
import { HETZNER_CLOUD_FORCE_FORGET_CONFIRMATION, type HetznerCloudConnectionDto } from "@/lib/infrastructure/contracts";
import { HETZNER_FIRST_BOOT_CLEANUP_CONFIRMATION } from "@/lib/infrastructure/hetzner-cleanup-contracts";
jest.mock("@/lib/infrastructure/hetzner-cleanup-client",()=>({
  ...jest.requireActual("@/lib/infrastructure/hetzner-cleanup-client"),
  advanceCleanup:jest.fn(),forgetCleanupAccess:jest.fn(),listCleanupOrders:jest.fn(),previewCleanup:jest.fn(),
}));
const view:HetznerCleanupView={
  orderId:"22222222-2222-4222-8222-222222222222",connectionId:"11111111-1111-4111-8111-111111111111",
  serverName:"hivra-22222222222242228222",status:"created_off",eligible:true,fingerprint:"a".repeat(64),
  resources:{server:"42",ipv4:"88",ipv6:"89",sshKey:"77"},cleanup:null,
  observedAbsence:{server:false,ipv4:false,ipv6:false,sshKey:false},
};
const connection={id:view.connectionId,name:"My project"} as HetznerCloudConnectionDto;
const key="33333333-3333-4333-8333-333333333333";
const state={idempotencyKey:key,fingerprint:view.fingerprint!,absence:{server:true,ipv4:false,ipv6:false,sshKey:false},
  error:null,startedAt:"2026-08-27T16:00:00Z",observedAt:"2026-08-27T16:01:00Z",finishedAt:null};
beforeEach(()=>{
  jest.clearAllMocks();
  (listCleanupOrders as jest.Mock).mockResolvedValue({orders:[view]});
  (previewCleanup as jest.Mock).mockResolvedValue(view);
  Object.defineProperty(global.crypto,"randomUUID",{configurable:true,value:()=>key});
});
it("opens a padded review, not a deletion, and requires the exact server name",async()=>{
  render(<HetznerCloudCleanupDialog connection={connection} onClose={jest.fn()} onComplete={jest.fn()}/>);
  const input=await screen.findByRole("textbox");
  const button=screen.getByRole("button",{name:"Delete confirmed resources"});
  await waitFor(()=>expect(input).toBeEnabled());
  expect(button).toBeDisabled();expect(advanceCleanup).not.toHaveBeenCalled();
  fireEvent.change(input,{target:{value:"another server"}});expect(button).toBeDisabled();
  fireEvent.change(input,{target:{value:view.serverName}});expect(button).toBeEnabled();
  expect(screen.getByRole("dialog")).toHaveAccessibleName("Remove an unused server.");
});
it("advances the same confirmed intent and only reports success on a completed receipt",async()=>{
  const complete=jest.fn();
  (advanceCleanup as jest.Mock)
    .mockResolvedValueOnce({...view,status:"cleaning",cleanup:state})
    .mockResolvedValueOnce({...view,status:"cleaning",cleanup:{...state,absence:{server:true,ipv4:true,ipv6:false,sshKey:false}}})
    .mockResolvedValueOnce({...view,status:"cleaning",cleanup:{...state,absence:{server:true,ipv4:true,ipv6:true,sshKey:false}}})
    .mockResolvedValueOnce({...view,status:"deleted",cleanup:{...state,finishedAt:"2026-08-27T16:02:00Z",absence:{server:true,ipv4:true,ipv6:true,sshKey:true}}});
  render(<HetznerCloudCleanupDialog connection={connection} onClose={jest.fn()} onComplete={complete}/>);
  const input=await screen.findByRole("textbox");await waitFor(()=>expect(input).toBeEnabled());
  fireEvent.change(input,{target:{value:view.serverName}});
  fireEvent.click(screen.getByRole("button",{name:"Delete confirmed resources"}));
  await screen.findByRole("heading",{name:"Removal verified."});
  expect(advanceCleanup).toHaveBeenCalledTimes(4);expect(complete).toHaveBeenCalledTimes(1);
  for(const args of (advanceCleanup as jest.Mock).mock.calls)expect(args[1]).toMatchObject({orderId:view.orderId,idempotencyKey:key,fingerprint:view.fingerprint});
});
it("stops automatic work after a partial failure and retains a resume path",async()=>{
  (advanceCleanup as jest.Mock).mockResolvedValue({...view,status:"cleaning",cleanup:{...state,error:"provider_unavailable"}});
  const complete=jest.fn();
  render(<HetznerCloudCleanupDialog connection={connection} onClose={jest.fn()} onComplete={complete}/>);
  const input=await screen.findByRole("textbox");await waitFor(()=>expect(input).toBeEnabled());
  fireEvent.change(input,{target:{value:view.serverName}});
  fireEvent.click(screen.getByRole("button",{name:"Delete confirmed resources"}));
  await screen.findByRole("alert");
  expect(advanceCleanup).toHaveBeenCalledTimes(1);expect(complete).not.toHaveBeenCalled();
  expect(screen.getByRole("button",{name:"Resume cleanup"})).toBeEnabled();
});
it("shows the setup firewall and uses the started-computer confirmation for all five steps",async()=>{
  const boot={...view,resources:{...view.resources!,firewall:"91"},
    observedAbsence:{...view.observedAbsence!,firewall:false}};
  (listCleanupOrders as jest.Mock).mockResolvedValue({orders:[boot]});
  (previewCleanup as jest.Mock).mockResolvedValue(boot);
  const absence={server:false,firewall:false,ipv4:false,ipv6:false,sshKey:false};
  for(const kind of ["server","firewall","ipv4","ipv6","sshKey"] as const){
    absence[kind]=true;
    (advanceCleanup as jest.Mock).mockResolvedValueOnce({...boot,status:kind==="sshKey"?"deleted":"cleaning",
      cleanup:{...state,absence:{...absence},finishedAt:kind==="sshKey"?"2026-08-27T16:02:00Z":null}});
  }
  const complete=jest.fn();
  render(<HetznerCloudCleanupDialog connection={connection} onClose={jest.fn()} onComplete={complete}/>);
  const input=await screen.findByRole("textbox");await waitFor(()=>expect(input).toBeEnabled());
  expect(screen.getByText("Setup firewall")).toBeInTheDocument();
  expect(screen.getByRole("dialog")).toHaveAccessibleName("Remove this setup computer.");
  expect(screen.getByText("#91")).toBeInTheDocument();
  expect(screen.getByText(/permanently delete a computer started during setup/)).toBeInTheDocument();
  expect(advanceCleanup).not.toHaveBeenCalled();
  fireEvent.change(input,{target:{value:view.serverName}});
  fireEvent.click(screen.getByRole("button",{name:"Delete confirmed resources"}));
  await screen.findByText("All five original resources are confirmed absent.");
  expect(advanceCleanup).toHaveBeenCalledTimes(5);
  expect(complete).toHaveBeenCalledTimes(1);
  for(const args of (advanceCleanup as jest.Mock).mock.calls)expect(args[1]).toMatchObject({
    confirmation:HETZNER_FIRST_BOOT_CLEANUP_CONFIRMATION,idempotencyKey:key,fingerprint:view.fingerprint,
  });
});
it("does not offer destructive automation for missing original receipts",async()=>{
  (listCleanupOrders as jest.Mock).mockResolvedValue({orders:[{...view,eligible:false,resources:null,fingerprint:null}]});
  render(<HetznerCloudCleanupDialog connection={connection} onClose={jest.fn()} onComplete={jest.fn()}/>);
  await screen.findByText(/no complete original-resource receipt/);
  expect(previewCleanup).not.toHaveBeenCalled();
  expect(screen.queryByRole("button",{name:"Delete confirmed resources"})).not.toBeInTheDocument();
});
it("provides a separately confirmed credential revocation path after token failure",async()=>{
  const stuck={...view,status:"cleaning",cleanup:{...state,error:"provider_unavailable"}};
  (listCleanupOrders as jest.Mock).mockResolvedValue({orders:[stuck]});
  (previewCleanup as jest.Mock).mockRejectedValue(new Error("Token no longer works"));
  (forgetCleanupAccess as jest.Mock).mockResolvedValue({connectionDeleted:true,localCredentialsWiped:true,providerCleanupPerformed:false,canarySlotHeld:true});
  const forgot=jest.fn();const complete=jest.fn();
  render(<HetznerCloudCleanupDialog connection={connection} onClose={jest.fn()} onComplete={complete} onForgot={forgot}/>);
  await screen.findByRole("alert");
  fireEvent.click(screen.getByText("Cannot access the project anymore?"));
  const button=screen.getByRole("button",{name:"Forget access, keep provider resources"});
  expect(button).toBeDisabled();
  fireEvent.change(screen.getByRole("textbox",{name:"Type "+HETZNER_CLOUD_FORCE_FORGET_CONFIRMATION}),{target:{value:HETZNER_CLOUD_FORCE_FORGET_CONFIRMATION}});
  fireEvent.click(button);
  await waitFor(()=>expect(forgot).toHaveBeenCalledTimes(1));
  expect(advanceCleanup).not.toHaveBeenCalled();expect(complete).not.toHaveBeenCalled();
});
