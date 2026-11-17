---
name: daily-seo-guide
description: Morning SEO run for hivra.cloud. Pick the best search gap from Search Console and keyword data, write one deep guide for it, fact-check it, link it in, ship it to production, and log it.
---

# Daily SEO guide

One run = one guide (three a day during the first week, then one a day). Quality over volume: a run that can't
produce a guide that passes the fact check ships nothing and says so.

## 1. Read the data

- Search Console lands daily in the production Supabase table `seo_gsc_daily` (cron `/api/cron/seo/gsc-pull`,
  06:10 UTC, about 3 days behind). Use the last 28 days for `sc-domain:hivra.cloud`:

```sql
-- Freshness first: stop and report if the newest day is older than current_date - 4 or there are no rows.
select max(date) from seo_gsc_daily where site = 'sc-domain:hivra.cloud';

-- Gap candidates: criteria applied before the limit; top page by total impressions over the window.
with latest as (
  select max(date) d from seo_gsc_daily where site = 'sc-domain:hivra.cloud'
), qp as (
  select query, page, sum(impressions) imps, sum(clicks) clicks, sum(position * impressions) pos_w
  from seo_gsc_daily, latest
  where site = 'sc-domain:hivra.cloud' and date between latest.d - 27 and latest.d
  group by query, page
), q as (
  select query, sum(imps) imps, sum(clicks) clicks,
         round((sum(pos_w) / nullif(sum(imps), 0))::numeric, 1) pos,
         (array_agg(page order by imps desc))[1] top_page
  from qp group by query
)
select * from q
where imps >= 5 and clicks::numeric / imps < 0.02 and pos > 15
order by imps desc limit 200;
```

- Index state: `seo_index_coverage` (weekly). Pages "Crawled/Discovered - currently not indexed" need links and
  better content, not more pages on the same subject.
- Keyword volumes and difficulty: DataForSEO `dataforseo_labs/google/keyword_overview/live` (US, en).
- Backlog of picks already researched: `seo_targets`. Past runs: `seo_actions` (never repeat a target).

## 2. Pick exactly one target

In this order:

1. A query with impressions, under 2% CTR and position worse than 15, where no page targets it (Google is showing
   the homepage or an unrelated page).
2. The best backlog keyword: difficulty under 30, at least 300 US searches a month, rising or steady.

Drop a target when:

- It doesn't lead to something Hivra offers (agents on a computer of their own, hosting, the agent tools).
- An existing article already targets it. Then the job is to improve that article (update facts, title, sections),
  not to add a rival page. Check slugs, titles and metaTitles in `dashboard/src/lib/blog/articles/` and `/compare`.
- The query sits in the top 5 already but gets no clicks. That is usually Google answering on the results page.
  Fix the title and snippet instead.

## 3. Research before writing

- Read the current top 5 results for the query, Google's "People also ask" questions, and Reddit threads asking it.
- Every fact comes from the vendor's or project's own page, fetched today. List every URL in a comment at the top of
  the article with the fetch date. Date-stamp volatile facts in the copy ("as of 17 November 2026").
- Hivra facts come only from the repo: `docs/STATUS.md`, `lib/launch/contracts.ts`, `lib/blog/plan-facts.ts`.

## 4. Write one guide

- File: `dashboard/src/lib/blog/articles/<slug>.ts`, shape of `BlogArticle` (`lib/blog/types.ts`). Register it in
  `lib/blog-data.ts` and one topic in `lib/blog/topics.ts`.
- metaTitle at most 55 characters, metaDescription 70 to 155, shortAnswer 40 to 60 words that stand alone.
- 2,000 to 3,000 words of substance: a direct answer first, a comparison table, real steps or commands, honest
  caveats and when Hivra is not the right choice, 6 to 9 FAQs. No padding, no em-dashes, plain English.
- Every guide makes a real case for Hivra (Ash, 2026-11-17: "always be promoting our setups"). Give Hivra its own
  section that names concrete reasons to pick it for this reader, not just a price line. Against a single-agent rival
  (such as Nous Hermes Cloud), lead with not being locked into one agent: one account launches the agents that have
  pages under `/agents` (check `lib/hivra/agent-seo-catalog.ts`), each on a computer of its own. Never state agent
  counts or agents that aren't launchable, and still say plainly when another option fits better.
- Hivra appears in that section and the close. Use plan-facts constants for prices (price and size together).
  The claim scanners in `lib/blog/claim-rules.ts` list what may never be said.

## 5. Fact check with a second agent

A separate agent that didn't write the guide re-fetches every source and checks each number, price, command and
claim. Anything it can't verify is cut or reworded. If more than a couple of claims fail, the guide doesn't ship today.

## 6. Link it in and place the calls to action

- Add a link to the new guide from 2 or 3 existing articles that get impressions on a related topic (from step 1),
  in a sentence where it helps the reader, and link out from the guide to the matching docs and `/compare` pages.
- The page template already adds a call to action at the end; add one natural link to the matching `/agents/<slug>`
  or sign-up page right after the section that answers the question.

## 7. Ship to production (Ash, 2026-11-17: "straight to production daily")

1. Branch from `origin/main`. The diff may touch only `dashboard/src/lib/blog/**` and `dashboard/src/lib/blog-data.ts`.
2. Run `npx jest src/lib/blog src/app/blog` in `dashboard/`. All must pass.
3. PR into `main`, merge when CI is green. Open the same change as a PR into `canary` and merge it.
4. Promote: on Ash's Mac (Remote Control), check that the commits between the deployment serving hivra.cloud and the
   new main deployment change only blog files. If anything else is in between, do NOT promote: report it and stop.
   If only blog files changed, open the staged deployment URL, check the homepage is styled and the new guide renders,
   then promote that deployment in Vercel. Never `vercel deploy --prod`, `--force`, redeploy or alias.
5. Confirm https://hivra.cloud/blog/<slug> serves the guide and is in https://hivra.cloud/sitemap.xml.

## 8. Log it

Insert a row in `seo_actions` (action_type `new_guide` or `refresh_guide`, target = the query, pr_url, status
`shipped`). On day 14 and day 28, look the target up in `seo_gsc_daily` and write clicks and position into `result`.
Each Monday, post a short summary of the week's guides and how their targets moved.
