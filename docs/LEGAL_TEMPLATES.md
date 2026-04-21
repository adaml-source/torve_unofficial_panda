# Legal templates — Terms, Privacy, DPA

> **⚠️ NOT LEGAL ADVICE. A LAWYER MUST REVIEW THESE BEFORE YOU PUBLISH ANYTHING.**
>
> These are technical-director-drafted starting points covering what a
> Panda-hosting service needs to address. They are NOT sufficient as-is
> for any jurisdiction. They do not cover:
>
> - Your business's actual legal structure, name, registered address
> - Jurisdiction-specific consumer protection requirements
> - EU vs UK GDPR divergence, CCPA, LGPD, Australian Privacy Act, etc.
> - Dispute resolution / arbitration clauses (jurisdiction-specific)
> - Payment-processor-specific terms if you charge (Paddle, Stripe, etc.)
> - Liability limitation language that actually holds up in court
>
> Hand these to a lawyer specializing in SaaS / data protection in your
> operating jurisdiction. Plan for at least one review round. Budget
> €1–3k for a competent review of the full package.

---

## 1. Terms of Service skeleton

```
PANDA TERMS OF SERVICE
Last updated: [DATE]

1. WHAT PANDA IS
Panda is a server-side addon orchestration service operated by [YOUR
LEGAL ENTITY NAME] ("we", "us"). Panda accepts your third-party service
credentials (debrid provider API keys, Usenet service passwords, NZB
indexer API keys, cloud download client tokens) and uses them on your
behalf to assemble streaming URLs from those services.

Panda does NOT:
- Host, store, or index any media content
- Act as a content source; all content is retrieved from the third-
  party services whose credentials you provide
- Operate any CDN, cache, or storage layer for media

2. YOUR RESPONSIBILITIES
By using Panda, you confirm that:
- You have valid, active accounts with the third-party services whose
  credentials you enter
- You comply with those third-party services' terms of service,
  acceptable use policies, and monthly quotas
- You have the legal right to access whatever content you request
  through those services
- You will not share your Panda manifest URL or management token with
  persons who are not authorized users of your account

3. WHAT YOU PAY FOR
[If free]: Panda is provided free of charge. We may introduce paid
tiers with 30 days' notice.
[If paid]: [pricing, billing cycles, refund policy, payment processor]

4. WHAT WE PROMISE
- Best-effort availability. We do not guarantee uptime.
- Encryption at rest for stored credentials, and our security posture
  as documented at [public security doc URL].
- Notification within 72 hours of discovering any incident that may
  have exposed your credentials.

5. WHAT WE DON'T PROMISE
- Availability of any third-party service (Easynews, debrid providers,
  NZB indexers, etc.). If they go down, Panda goes down for their
  customers.
- Any particular streaming speed, resolution, or language availability —
  these depend entirely on third-party service inventory.
- Data recovery if you lose your management token AND have no backup.
- Legal protection for your use of the content retrieved via Panda.

6. TERMINATION
You can delete your config at any time via the app (Settings → Panda →
Delete) or by calling POST /api/v1/configs/me/purge. We may terminate
service for any account violating these terms or abusing our
infrastructure (e.g. rate-limit-exceeding bots).

7. LIABILITY LIMITATION
[LAWYER SECTION — liability caps, indemnification, force majeure, etc.
These vary wildly by jurisdiction; do not copy generic text here.]

8. CHANGES
We may update these terms with 30 days' notice via [notification
channel]. Continued use after notice = acceptance.

9. GOVERNING LAW
[LAWYER SECTION]
```

---

## 2. Privacy Policy skeleton

```
PANDA PRIVACY POLICY
Last updated: [DATE]
Data controller: [YOUR LEGAL ENTITY, registered address, DPO contact]

1. WHAT WE COLLECT
a) Credentials you enter: debrid API keys, Usenet credentials, NZB
   indexer keys, download-client credentials. Purpose: use them to
   retrieve streaming URLs on your request. Legal basis: contract
   performance (GDPR Art. 6(1)(b)).

b) Request metadata: which Panda endpoint you hit, when, from which
   IP address, via which user-agent. Purpose: security incident
   investigation. Legal basis: legitimate interest (GDPR Art. 6(1)(f))
   — specifically, our interest in detecting abuse balanced against
   your interest in privacy. Retention: 12 weeks, then automatic
   rotation.

c) What we DO NOT collect:
   - Name, email, physical address, phone number
   - Payment information (handled by [payment processor] under their
     policy at [link])
   - Watch history, content preferences, any catalogue interaction
   - Device identifiers, advertising IDs, analytics cookies

2. HOW WE PROTECT IT
- AES-256-GCM encryption at rest for every stored credential
- HTTPS-only transport (TLS 1.2+)
- Per-config access tokens; leaked stream URL cannot modify credentials
- File-system isolation: the Panda service runs as a non-root user
  with permissions restricted to its data directory

Full technical detail: [link to SECURITY.md].

3. WHO WE SHARE WITH
- Third-party services you've configured (Easynews, Real-Debrid,
  SCENENZBS, etc.): we use YOUR credentials to call YOUR accounts on
  those services. We do not share credentials with anyone else.
- Our infrastructure provider: [hosting provider name, location of
  servers].
- No advertisers, no analytics providers, no data brokers.

4. WHERE YOUR DATA LIVES
Servers hosted in [location — e.g. "Germany (Frankfurt)" or "the United
States (Virginia)"]. By using Panda you consent to transfer of your
credentials to that jurisdiction.

5. YOUR RIGHTS (GDPR / UK DP Act — applicable if you're in EEA/UK)
- Access: request a copy of everything we hold about your config via
  GET /api/v1/configs/me/export
- Erasure: POST /api/v1/configs/me/purge wipes your config and scrubs
  identifiers from our audit log
- Rectification: edit your config via the app
- Portability: the export endpoint returns JSON, directly usable
- Restriction / objection: contact [DPO email]

We respond to rights requests within 30 days.

6. SUPERVISORY AUTHORITY
You can complain to your local data protection authority:
- EU: [link to EDPB authority lookup]
- UK: https://ico.org.uk
- [Other jurisdictions as applicable]

7. CONTACT
[DPO email], or [postal address if applicable].

8. CHANGES
Material changes announced 30 days before effect via [channel].
```

---

## 3. Data Processing Addendum (DPA) — for B2B customers

Required if any customer is a business processing personal data through
Panda on behalf of their own users. Use a standard DPA template; these
are well-precedented (GDPR Art. 28 prescribes the structure). Two
practical options:

- **Free**: adapt an open DPA such as the one published by the
  European Commission (standard contractual clauses).
- **Template service**: companies like iubenda, Termly, or TermsFeed
  generate a DPA for ~€30–100/year based on your answers.
- **Bespoke**: lawyer-drafted, €1–3k.

If you only have individual-consumer customers (B2C), you do not need a
DPA — they're not controllers, they're data subjects.

---

## 4. Incident notification template

GDPR Art. 33 requires notification of a personal-data breach to the
supervisory authority within 72 hours, and to affected data subjects
"without undue delay" if the breach is likely to result in a high risk
to their rights.

```
Subject: Panda security incident notification — [DATE]

Dear [customer name],

On [date/time UTC] we became aware of a security incident that may have
affected data associated with your Panda configuration.

WHAT HAPPENED
[Factual description — what was accessed, by whom if known, over what
period.]

WHAT DATA WAS INVOLVED
[Specifically: credentials? audit metadata? both?]

WHAT WE'VE DONE
[Rotated all encryption keys / invalidated all tokens / other
mitigation. Be specific.]

WHAT YOU SHOULD DO
[Rotate your debrid key / change your Usenet password / reinstall
Panda / etc. — whichever applies to the specific incident.]

CONTACT
[DPO email or dedicated incident-response contact].

We sincerely apologize for this incident and for any concern it causes.

[Your name, role]
```

---

## Checklist before going live with paying customers

- [ ] Legal entity registered in your operating jurisdiction
- [ ] ToS drafted and reviewed by a lawyer
- [ ] Privacy Policy drafted and reviewed by a lawyer
- [ ] Privacy Policy linked from every signup / purchase flow
- [ ] DPO identified (may be you) with a monitored email address
- [ ] Breach-notification process documented and tested (who does what
      within 72h)
- [ ] Backup strategy implemented (see SECURITY.md) and last restore
      tested
- [ ] At least one customer communication channel besides "GitHub issue"
- [ ] Payment processor's data-processing addendum signed (Paddle,
      Stripe, etc. all have them)
- [ ] Clear "customers bring their own credentials / accept those
      services' ToS" language in signup
