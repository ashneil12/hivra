/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import LandingPage from "@/app/page";
import DownloadPage from "@/app/download/page";

jest.mock("@clerk/nextjs/server",()=>({auth:async()=>({userId:null})}));
jest.mock("next/headers",()=>({cookies:async()=>({get:()=>undefined}),headers:async()=>({get:()=>null})}));
jest.mock("@/components/landing/home.module.css",()=>({}));
jest.mock("@/components/public-site/PublicSite",()=>({__esModule:true,default:({children}:{children:ReactNode})=><>{children}</>}));

test("the homepage tells the product story once and keeps the transition with tokenomics",async()=>{
 render(await LandingPage({}));
 expect(screen.getByRole("link",{name:"Download the app"})).toHaveAttribute("href","/download");
 expect(screen.getByRole("tablist",{name:"Choose your starting point"})).toBeVisible();
 expect(screen.getByRole("heading",{name:"Your work. Right where you left it."})).toBeVisible();
 expect(screen.getByRole("article",{name:"Free"})).toBeVisible();
 for(const title of ["One place to manage everything.","A computer you can actually work in.","Another computer.Plenty of reasons.","What you're paying for."]){
  expect(screen.queryByRole("heading",{name:title})).not.toBeInTheDocument();
 }
 expect(screen.getAllByRole("heading",{name:"Start with an agent. Or a computer."})).toHaveLength(1);
 expect(screen.getByRole("heading",{name:"What happened to HermesOS?"}).closest("section")).toHaveAttribute("id","tokenomics");
 expect(screen.getByRole("heading",{name:"Built to be open. Yours to run."}).compareDocumentPosition(screen.getByRole("article",{name:"Free"})) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
});

test("app CTA has a real destination and does not manufacture installer availability",()=>{
 render(<DownloadPage />);
 expect(screen.getByRole("heading",{level:1,name:"Hivra on your desktop."})).toBeVisible();
 expect(screen.getByRole("button",{name:/Download for macOS/})).toBeDisabled();
 expect(screen.getByRole("button",{name:/Download for Windows/})).toBeDisabled();
 expect(screen.getByRole("link",{name:"Open Hivra in your browser"})).toHaveAttribute("href","/dashboard");
});
