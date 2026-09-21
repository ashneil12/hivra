/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";
import PricingSection from "../PricingSection";
import { LocaleProvider } from "@/components/i18n/LocaleProvider";
import { SUPPORTED_LOCALES } from "@/lib/i18n";

test("locked relaunch ladder includes all resources and computer entitlements", () => {
  render(<PricingSection />);
  expect(screen.getByRole("heading",{name:/Pick a size. Use it how you like./})).toBeVisible();
  for(const [name,price,ram,cpu,storage,computers,windows,support] of [
    ["Starter","$9.99","4 GB","2","40 GB","1","Not included","Standard"],
    ["Pro","$19.99","8 GB","4","160 GB","3","Yes","Standard"],
    ["Studio","$49","16 GB","8","320 GB","Unlimited","Yes","Priority"],
    ["Max","$99","32 GB","12","640 GB","Unlimited","Yes","Priority"],
  ]){
    const card=screen.getByRole("article",{name});
    expect(card).toHaveTextContent(price);
    for(const [label,value] of [["RAM",ram],["vCPU",cpu],["Storage",storage],["Computers",computers],["Windows",windows],["Support",support]]){
      expect(within(card).getByText(label).nextElementSibling).toHaveTextContent(value);
    }
  }
  expect(screen.queryByRole("heading",{name:"Fleet"})).not.toBeInTheDocument();
  expect(screen.getByRole("link",{name:"View hosted options"})).toHaveAttribute("href","/dashboard/infrastructure");
});
test("self-host stays separate and no retired agent quota or trial returns",()=>{
  const {container}=render(<PricingSection />);
  expect(container).not.toHaveTextContent(/trial|starter agent|concurrent|Vultr|DigitalOcean|per agent/i);
  const free = screen.getByRole("article",{name:"Free"});
  expect(free).toBeVisible();
  expect(free).toHaveTextContent("Bring your own infrastructure.");
  expect(free).toHaveTextContent("Hosting and model-provider usage are paid separately.");
  expect(container).not.toHaveTextContent(/Run one agent or twenty|charge per seat/i);
  expect(screen.getByText(/Snapshots and clones on every hosted plan/)).toBeVisible();
  expect(screen.getByText("Annual billing: two months free.")).toBeVisible();
  expect(screen.getByRole("link",{name:"Explore self-hosting"})).toHaveAttribute("target","_blank");
});
test.each(SUPPORTED_LOCALES)("locked ladder stays visible without retired prices in %s",locale=>{
 render(<LocaleProvider initialLocale={locale}><PricingSection /></LocaleProvider>);
 expect(screen.getAllByRole("article")).toHaveLength(5);
 expect(screen.getByRole("heading",{name:"Max"})).toBeVisible();
});
