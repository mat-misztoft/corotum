import type { Metadata } from "next";
import { LegalDocument } from "../legal-document";

export const metadata: Metadata = {
  title: "Privacy Policy | Corotum",
};

export default function PrivacyPage() {
  return (
    <LegalDocument>
      <h1 id="legal-title">Privacy Policy</h1>
      <p>
        <strong>Last updated: September 3, 2026</strong>
      </p>
      <p>
        This Privacy Policy explains how personal data is processed in
        connection with Corotum, including corotum.com and the hosted Corotum
        Cloud service.
      </p>
      <p>For privacy-related questions, contact:</p>
      <p>
        <strong>support@corotum.com</strong>
      </p>

      <h2>1. Scope</h2>
      <p>This Privacy Policy applies when you:</p>
      <ul>
        <li>visit corotum.com</li>
        <li>create a Corotum account</li>
        <li>authenticate using GitHub, Google, or an email magic link</li>
        <li>use Corotum Cloud</li>
        <li>connect a device to Corotum Cloud</li>
        <li>use the Corotum dashboard</li>
        <li>use the Cloud API</li>
        <li>use WebMCP</li>
        <li>contact us</li>
        <li>enable optional Corotum CLI telemetry</li>
      </ul>
      <p>Git Sync can be used without creating a Corotum account.</p>

      <h2>2. Information We Process</h2>
      <p>The information processed depends on how you use Corotum.</p>
      <h3>Account Information</h3>
      <p>
        When you authenticate using GitHub, Google, or an email magic link, we
        process information necessary to identify and authenticate your account.
      </p>
      <p>This may include:</p>
      <ul>
        <li>account identifier</li>
        <li>email address</li>
        <li>display name</li>
        <li>profile image</li>
      </ul>
      <p>
        For GitHub or Google sign-in, this can also include the provider account
        identifier and authentication tokens supplied by that provider (such as
        access, refresh, or ID tokens) where needed to operate the linked
        sign-in. For email magic links, we process the email address and a
        hashed, time-limited verification token. The exact information depends
        on the selected provider and permissions presented during
        authentication.
      </p>
      <h3>Corotum Cloud Information</h3>
      <p>
        When you use Corotum Cloud, we process information necessary to provide
        synchronization functionality.
      </p>
      <p>This may include:</p>
      <ul>
        <li>workspace identifiers</li>
        <li>device identifiers</li>
        <li>skill identifiers</li>
        <li>skill names</li>
        <li>repository or source references</li>
        <li>configured refs</li>
        <li>skill targets</li>
        <li>revisions</li>
        <li>synchronization status</li>
        <li>applied revision information</li>
        <li>supported agent identifiers</li>
        <li>update status</li>
        <li>resolution status</li>
        <li>related synchronization configuration</li>
        <li>
          billing and subscription status, including a payment-provider customer
          identifier
        </li>
      </ul>
      <p>
        For artifact-backed skills, Corotum Cloud also stores a sanitized, exact
        archive of the skill files in Cloudflare R2 so paired devices can
        install the locked content. Artifact creation rejects configured secret
        paths, but you should not place sensitive data in skill files.
      </p>
      <p>
        Corotum Cloud does not intentionally store your Git authentication
        credentials.
      </p>
      <p>In particular, we do not intentionally store:</p>
      <ul>
        <li>Git passwords</li>
        <li>personal access tokens</li>
        <li>SSH private keys</li>
        <li>Git credential helper credentials</li>
      </ul>
      <h3>Device and Technical Information</h3>
      <p>
        When your device communicates with Corotum Cloud, we may process
        technical information necessary to operate and secure the service.
      </p>
      <p>This may include:</p>
      <ul>
        <li>Corotum version</li>
        <li>operating system</li>
        <li>architecture</li>
        <li>device identifier</li>
        <li>supported agent information</li>
        <li>synchronization state</li>
        <li>request metadata</li>
        <li>IP address</li>
        <li>security-related network information</li>
      </ul>
      <h3>Billing Information</h3>
      <p>
        Hosted checkout is provided by Creem. Corotum sends Creem the account
        email, optional name, selected billing interval, and a Corotum user
        identifier needed to associate the subscription. Corotum receives and
        stores subscription status and the Creem customer identifier; it does
        not receive or store full payment-card details.
      </p>
      <h3>Support Communications</h3>
      <p>
        If you contact us, we process information contained in your message and
        any contact information you provide.
      </p>

      <h2>3. Optional CLI Telemetry</h2>
      <p>Corotum CLI may offer optional usage telemetry.</p>
      <p>
        Telemetry does not begin until you confirm your choice during the
        telemetry prompt or explicitly enable it through configuration.
      </p>
      <p>When telemetry is enabled, Corotum may collect:</p>
      <ul>
        <li>random anonymous installation identifier</li>
        <li>Corotum version</li>
        <li>operating system</li>
        <li>architecture</li>
        <li>command name</li>
        <li>execution duration</li>
        <li>success, partial success, or error result</li>
        <li>error code</li>
        <li>managed skill count</li>
        <li>active agent count</li>
        <li>supported agent identifiers</li>
      </ul>
      <p>Telemetry does not include:</p>
      <ul>
        <li>skill names</li>
        <li>repository URLs</li>
        <li>local filesystem paths</li>
        <li>skill contents</li>
        <li>access tokens</li>
        <li>credentials</li>
        <li>device names</li>
        <li>Git usernames</li>
        <li>Git email addresses</li>
      </ul>
      <p>
        The anonymous installation identifier used for telemetry is independent
        from Corotum Cloud user and device identifiers.
      </p>
      <p>Telemetry data is retained for no longer than 90 days.</p>
      <p>You can disable telemetry through Corotum configuration.</p>
      <p>
        CLI telemetry is separate from website analytics. Its installation
        identifier is not linked to Corotum Cloud accounts, devices, or website
        analytics identifiers.
      </p>

      <h2>4. Website Analytics</h2>
      <p>
        Corotum may use a self-hosted Umami instance for cookieless website and
        product analytics. This helps us understand aggregate page visits and
        explicitly defined product events.
      </p>
      <p>
        Website analytics does not use the CLI telemetry installation
        identifier. We do not send skill names, repository URLs, skill content,
        account email addresses, device names, workspace identifiers, or source
        references as Umami event data.
      </p>

      <h2>5. Why We Process Information</h2>
      <p>We process information for the following purposes.</p>
      <h3>Providing Corotum Cloud</h3>
      <p>
        Account, workspace, device, and synchronization information is processed
        to provide the functionality requested by you.
      </p>
      <p>
        Legal basis: performance of a contract or steps taken at your request.
      </p>
      <h3>Authentication</h3>
      <p>
        Authentication information is processed to identify users and provide
        access to Corotum Cloud.
      </p>
      <p>Legal basis: performance of a contract.</p>
      <h3>Security</h3>
      <p>Technical and network information may be processed to:</p>
      <ul>
        <li>protect user accounts</li>
        <li>prevent unauthorized access</li>
        <li>investigate security incidents</li>
        <li>prevent abuse</li>
        <li>protect Corotum infrastructure</li>
      </ul>
      <p>Legal basis: our legitimate interest in operating a secure service.</p>
      <h3>Optional Telemetry</h3>
      <p>
        Where optional telemetry involves personal data or pseudonymous
        identifiers, it is processed based on your consent.
      </p>
      <p>You may withdraw that consent by disabling telemetry.</p>
      <h3>Billing</h3>
      <p>
        Billing information is processed to provide hosted subscriptions, manage
        access, and meet applicable accounting or legal obligations.
      </p>
      <p>
        Legal basis: performance of a contract and legal obligations where
        applicable.
      </p>
      <h3>Support</h3>
      <p>
        Information submitted through support communications is processed to
        respond to your request.
      </p>
      <p>
        Legal basis: performance of a contract, steps taken at your request, or
        our legitimate interest in communicating with users.
      </p>

      <h2>6. Git Sync</h2>
      <p>Git Sync can operate without a Corotum account.</p>
      <p>
        When using Git Sync, the Corotum CLI interacts directly with the Git
        repository configured by you using Git and the authentication mechanisms
        available on your device.
      </p>
      <p>
        Corotum does not receive your Git repository contents merely because you
        use standalone Git Sync.
      </p>
      <p>
        Your Git hosting provider processes information according to its own
        privacy terms.
      </p>
      <p>Optional telemetry remains separate and is sent only if enabled.</p>

      <h2>7. Authentication Providers</h2>
      <p>Corotum supports the following sign-in methods:</p>
      <ul>
        <li>GitHub</li>
        <li>Google</li>
        <li>email magic link</li>
      </ul>
      <p>
        When you use one of these providers, the provider processes information
        relating to authentication according to its own privacy policy.
      </p>
      <p>
        Corotum receives only the information made available through the
        authentication process required for the requested functionality.
      </p>

      <h2>8. Cloud Infrastructure</h2>
      <p>
        Corotum uses Cloudflare infrastructure to operate parts of the service.
      </p>
      <p>
        Cloudflare may process technical information where necessary to provide
        services such as:
      </p>
      <ul>
        <li>hosting</li>
        <li>networking</li>
        <li>security</li>
        <li>storage</li>
        <li>database infrastructure</li>
        <li>analytics infrastructure</li>
      </ul>
      <p>
        Optional Corotum CLI telemetry may be stored using Cloudflare Analytics
        Engine. Self-hosted Umami analytics data is stored in the Corotum
        analytics deployment.
      </p>

      <h2>9. Data Retention</h2>
      <p>
        We retain information only for as long as necessary for the purposes
        described in this Policy.
      </p>
      <p>In particular:</p>
      <ul>
        <li>
          account and Corotum Cloud information is generally retained while the
          account or workspace remains active
        </li>
        <li>
          artifact archives retain the current and immediately previous archive
          for each skill; unreferenced archives are deleted when safely eligible
        </li>
        <li>
          billing and subscription records are retained as needed for the
          subscription, accounting, and legal obligations
        </li>
        <li>
          technical and security information may be retained where necessary for
          security, abuse prevention, or legal purposes
        </li>
        <li>optional telemetry is retained for no longer than 90 days</li>
        <li>
          support communications may be retained as necessary to resolve
          requests and maintain appropriate records
        </li>
      </ul>
      <p>
        Information that is no longer required is deleted or anonymized where
        reasonably possible.
      </p>

      <h2>10. Data Recipients</h2>
      <p>
        Depending on the features you use, information may be processed by
        service providers necessary to operate Corotum.
      </p>
      <p>These may include:</p>
      <ul>
        <li>
          Cloudflare, for infrastructure, hosting, networking, and security
        </li>
        <li>GitHub, when GitHub authentication is used</li>
        <li>Google, when Google authentication is used</li>
        <li>
          Creem, for hosted checkout, subscriptions, and the billing portal
        </li>
        <li>
          infrastructure and technical service providers necessary to operate
          Corotum
        </li>
        <li>
          professional advisers or authorities where disclosure is required by
          law
        </li>
      </ul>
      <p>
        Service providers acting on our behalf process information only as
        necessary to provide their services.
      </p>

      <h2>11. International Data Transfers</h2>
      <p>
        Some service providers may process information outside the European
        Economic Area.
      </p>
      <p>
        Where required by applicable data protection law, appropriate safeguards
        are used for such transfers.
      </p>
      <p>These may include:</p>
      <ul>
        <li>adequacy decisions</li>
        <li>Standard Contractual Clauses</li>
        <li>other legally recognized transfer mechanisms</li>
      </ul>

      <h2>12. Cookies and Browser Storage</h2>
      <p>Corotum may use cookies or similar browser storage necessary for:</p>
      <ul>
        <li>authentication</li>
        <li>maintaining user sessions</li>
        <li>security</li>
        <li>remembering essential application state</li>
      </ul>
      <p>
        When enabled, Umami analytics is configured without analytics cookies.
        Non-essential tracking technologies requiring consent will not be
        intentionally enabled without the required consent.
      </p>

      <h2>13. Your Data Protection Rights</h2>
      <p>Where the GDPR applies, you may have the right to:</p>
      <ul>
        <li>access your personal data</li>
        <li>correct inaccurate information</li>
        <li>request deletion</li>
        <li>restrict processing</li>
        <li>object to certain processing</li>
        <li>receive certain information in a portable format</li>
        <li>withdraw consent where processing relies on consent</li>
        <li>lodge a complaint with a data protection authority</li>
      </ul>
      <p>
        If you are located in Poland, the competent supervisory authority is the
        President of the Personal Data Protection Office, Prezes Urzędu Ochrony
        Danych Osobowych.
      </p>
      <p>To exercise your rights, contact:</p>
      <p>
        <strong>support@corotum.com</strong>
      </p>
      <p>We may need to verify your identity before processing a request.</p>

      <h2>14. Account Deletion</h2>
      <p>
        You may request deletion of your Corotum account by contacting
        support@corotum.com. The dashboard can delete Cloud desired state, but
        that action does not itself delete the account.
      </p>
      <p>Account deletion may result in deletion of or loss of access to:</p>
      <ul>
        <li>Cloud workspaces</li>
        <li>hosted desired state</li>
        <li>device associations</li>
        <li>related Corotum Cloud data</li>
      </ul>
      <p>
        Some information may be retained where required for security, legal
        compliance, or the establishment, exercise, or defense of legal claims.
      </p>
      <p>
        Deleting a Corotum Cloud account does not affect repositories or files
        stored independently on your devices or Git providers.
      </p>

      <h2>15. Automated Decision Making</h2>
      <p>
        Corotum does not use personal data for solely automated decision-making
        that produces legal or similarly significant effects concerning you.
      </p>

      <h2>16. Security</h2>
      <p>
        We use technical and organizational measures intended to protect
        information against:
      </p>
      <ul>
        <li>unauthorized access</li>
        <li>alteration</li>
        <li>disclosure</li>
        <li>destruction</li>
        <li>loss</li>
      </ul>
      <p>No Internet-based service can guarantee absolute security.</p>
      <p>
        You are responsible for protecting credentials and devices used to
        access Corotum.
      </p>

      <h2>17. Changes to This Privacy Policy</h2>
      <p>
        We may update this Privacy Policy when Corotum, our infrastructure, or
        applicable legal requirements change.
      </p>
      <p>
        The current version will be published on corotum.com together with its
        effective date.
      </p>

      <h2>18. Contact</h2>
      <p>For questions about privacy or personal data:</p>
      <p>
        <strong>support@corotum.com</strong>
      </p>
    </LegalDocument>
  );
}
