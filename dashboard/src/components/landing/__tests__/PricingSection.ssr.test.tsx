/** @jest-environment node */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import PricingSection from "../PricingSection";

test("Free and all four hosted plans ship visibly in server HTML before hydration",()=>{
 const markup=renderToStaticMarkup(<PricingSection />);
 expect(markup.match(/<article\b/g)).toHaveLength(5);
 for(const price of ["$9.99","$19.99","$49","$99"])expect(markup).toContain(price);
 expect(markup).toContain("Bring your own infrastructure.");
 expect(markup).not.toMatch(/style="[^"]*(?:opacity:\s*0(?:;|")|visibility:\s*hidden|display:\s*none)/);
 expect(markup).not.toMatch(/<article[^>]*(?:hidden|aria-hidden="true")/);
});
