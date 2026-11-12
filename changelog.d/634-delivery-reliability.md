---
section: Fixed
issues: [634, 637, 638, 639, 664]
---
- Delivery events from Amazon SES keep arriving after a transient failure: the SNS signing certificate is cached only after a successful fetch, a stale certificate is fetched again at most once a minute, and one timeout or 5xx no longer rejects every bounce and complaint webhook for the life of the process.
- The unsubscribe check now reads the rendered e-mail, not the template source: a footer supplied by a reusable block passes, while prose that only mentions `unsubscribe_url` is refused, with the same answer at save and at publish. The link must also be usable: a hidden link (`display:none`, `visibility:hidden`, `hidden`, a covering style or a simple `<style>` rule), one outside the body, or one with no text or image alt text is refused with the reason.
- UTM tagging and click tracking now cover single-quoted and unquoted `href` links that authors write inside `mj-text`; the existing double-quoted output is unchanged.
- A push message that reached some devices while others hit a transient error now retries only the failed devices with the normal back-off, instead of marking the message `sent` and losing those notifications.
- Replying START to an SMS now works: the app role may delete its workspace’s `stop` suppression, so opting back in returns 200 and never removes a bounce or complaint suppression.
