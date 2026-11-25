# Plugin market index

`index.json` is a **format-1 DSH plugin market index** generated from
`package.json` and `plugin.json`. Do not edit `index.json` by hand.

```bash
npm run build:market
```

The build refuses to run while `package.json` is `private` or named `@local/*`,
because the index must name a package others can actually install. Build it from
the release copy (public npm name, `private` removed), then host the resulting
`index.json` at a public `https:` URL and add that URL in DSH
**Plugins → Discover → index sources**.

“Accepted by the market” here means someone with that index URL can search and
install the plugin; DSH itself ships no default index and does not crawl npm.
