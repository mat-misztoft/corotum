import type { Metadata } from "next";
import { LegalDocument } from "../legal-document";

export const metadata: Metadata = {
  title: "Terms of Service | Corotum",
};

export default function TermsPage() {
  return (
    <LegalDocument>
      <h1 id="legal-title">Terms of Service</h1>
      <p>
        <strong>Last updated: September 3, 2026</strong>
      </p>
      <p>
        These Terms of Service govern your use of Corotum, including the
        Corotum website, Corotum Cloud, WebMCP, CLI integrations, and related
        services.
      </p>
      <p>By using Corotum, you agree to these Terms.</p>

      <h2>1. About Corotum</h2>
      <p>
        Corotum is a tool for managing and synchronizing AI agent skills across
        computers, servers, development environments, and supported AI agent
        runtimes.
      </p>
      <p>Corotum currently provides two primary synchronization modes:</p>
      <h3>Git Sync</h3>
      <p>
        Git Sync allows you to maintain your desired state using a Git
        repository controlled by you.
      </p>
      <p>Git Sync does not require a Corotum account.</p>
      <h3>Corotum Cloud</h3>
      <p>
        Corotum Cloud is the hosted synchronization service available through
        corotum.com.
      </p>
      <p>It may provide features including:</p>
      <ul>
        <li>hosted desired state</li>
        <li>workspace management</li>
        <li>device management</li>
        <li>synchronization status</li>
        <li>skill and agent information</li>
        <li>revisions</li>
        <li>device pairing</li>
        <li>dashboard access</li>
        <li>Cloud API</li>
        <li>WebMCP</li>
      </ul>
      <p>
        Corotum Cloud changes the desired state stored by the service. It does
        not directly modify a remote device.
      </p>
      <p>
        A device is reconciled only when the Corotum CLI runs on that device
        and successfully applies the applicable desired state.
      </p>

      <h2>2. Current Availability</h2>
      <p>
        Corotum Cloud is available as a paid hosted service. Current prices
        are $5.99 per month or $59.90 per year.
      </p>
      <p>
        Pricing, checkout, and subscription management are presented before
        payment is required. Git Sync and self-hosted Corotum Cloud remain
        available without a hosted subscription.
      </p>

      <h2>3. Open Source Software</h2>
      <p>
        The Corotum software available through its public source repository is
        licensed under the GNU Affero General Public License version 3, AGPLv3.
      </p>
      <p>
        Your rights to use, copy, modify, and distribute software licensed
        under AGPLv3 are governed by that license.
      </p>
      <p>
        These Terms govern use of services operated through corotum.com and do
        not restrict rights granted under AGPLv3.
      </p>
      <p>
        Self-hosting Corotum does not require permission from Corotum beyond
        compliance with the applicable open source license.
      </p>

      <h2>4. Accounts</h2>
      <p>Some Corotum Cloud functionality may require an account.</p>
      <p>
        Accounts may be created using supported authentication providers,
        including GitHub and Google.
      </p>
      <p>You are responsible for:</p>
      <ul>
        <li>maintaining control of your authentication account</li>
        <li>protecting access to your devices and credentials</li>
        <li>ensuring that your use of Corotum is authorized</li>
        <li>notifying us if you believe your account has been compromised</li>
      </ul>
      <p>
        You may not impersonate another person or access another user&apos;s
        account without authorization.
      </p>

      <h2>5. Technical Requirements</h2>
      <p>Using Corotum may require:</p>
      <ul>
        <li>a supported operating system</li>
        <li>Internet access for Cloud features</li>
        <li>a supported web browser</li>
        <li>Git for Git-based functionality</li>
        <li>access to repositories referenced by your configuration</li>
        <li>a compatible version of the Corotum CLI</li>
      </ul>
      <p>
        Some functionality depends on third-party software or services and may
        become unavailable if those services are unavailable.
      </p>

      <h2>6. Git Repositories and Credentials</h2>
      <p>Corotum may interact with Git repositories configured by you.</p>
      <p>
        The Corotum CLI uses Git and the authentication mechanisms already
        configured on your device, including SSH configuration and credential
        helpers.
      </p>
      <p>Corotum Cloud does not intentionally collect or store:</p>
      <ul>
        <li>Git passwords</li>
        <li>personal access tokens</li>
        <li>SSH private keys</li>
        <li>Git credential helper credentials</li>
      </ul>
      <p>
        You are responsible for ensuring that you have permission to access and
        use repositories configured with Corotum.
      </p>

      <h2>7. Your Content and Configuration</h2>
      <p>
        You retain ownership of content and configuration that you provide to
        Corotum.
      </p>
      <p>
        To operate Corotum Cloud, you grant us permission to process and store
        information necessary to provide the service.
      </p>
      <p>This may include:</p>
      <ul>
        <li>skill metadata</li>
        <li>source references</li>
        <li>repository references</li>
        <li>configured refs</li>
        <li>targets</li>
        <li>revisions</li>
        <li>identifiers</li>
        <li>synchronization state</li>
        <li>related configuration</li>
      </ul>
      <p>
        You are responsible for ensuring that content managed through Corotum
        does not violate applicable law or third-party rights.
      </p>

      <h2>8. Acceptable Use</h2>
      <p>You must not use Corotum to:</p>
      <ul>
        <li>violate applicable law</li>
        <li>access systems or repositories without authorization</li>
        <li>distribute unlawful content</li>
        <li>compromise or disrupt Corotum infrastructure</li>
        <li>bypass authentication or authorization mechanisms</li>
        <li>interfere with other users</li>
        <li>
          gain unauthorized access to another user&apos;s workspace or data
        </li>
      </ul>
      <p>
        We may restrict or suspend access where reasonably necessary to protect
        Corotum, its infrastructure, users, or third parties.
      </p>

      <h2>9. Service Changes</h2>
      <p>Corotum is actively developed.</p>
      <p>
        Features may be added, modified, replaced, or removed as the product
        evolves.
      </p>
      <p>Changes may result from:</p>
      <ul>
        <li>technical development</li>
        <li>security requirements</li>
        <li>changes to third-party services</li>
        <li>legal requirements</li>
        <li>abuse prevention</li>
        <li>product development</li>
      </ul>
      <p>
        We may also change the availability or limits of the free hosted
        service.
      </p>

      <h2>10. Availability</h2>
      <p>
        We aim to keep Corotum Cloud available and reliable, but uninterrupted
        availability is not guaranteed.
      </p>
      <p>The service may temporarily become unavailable due to:</p>
      <ul>
        <li>maintenance</li>
        <li>infrastructure failures</li>
        <li>security incidents</li>
        <li>third-party outages</li>
        <li>technical problems</li>
        <li>circumstances outside our reasonable control</li>
      </ul>
      <p>
        Git Sync and self-hosted installations may continue operating
        independently of Corotum Cloud where technically possible.
      </p>

      <h2>11. Synchronization and Data Safety</h2>
      <p>Corotum is designed to reconcile desired and actual state.</p>
      <p>
        You remain responsible for maintaining appropriate backups of important
        files, repositories, and configurations.
      </p>
      <p>
        Corotum includes safeguards intended to prevent unmanaged or locally
        modified skills from being overwritten unintentionally.
      </p>
      <p>
        However, no software system can guarantee that data loss, configuration
        conflicts, software defects, or synchronization errors will never
        occur.
      </p>
      <p>
        You should review important changes before applying operations that may
        modify or remove files.
      </p>

      <h2>12. Third-Party Services</h2>
      <p>
        Corotum may depend on or integrate with third-party services, including
        authentication providers, Git hosting providers, and infrastructure
        providers.
      </p>
      <p>
        Your use of those services may also be governed by their respective
        terms and policies.
      </p>
      <p>
        We are not responsible for the availability, functionality, or actions
        of independent third-party services.
      </p>

      <h2>13. Disclaimer</h2>
      <p>
        Corotum is provided on an &quot;as is&quot; and &quot;as
        available&quot; basis to the maximum extent permitted by applicable
        law.
      </p>
      <p>We do not guarantee that Corotum will:</p>
      <ul>
        <li>always be available</li>
        <li>operate without errors</li>
        <li>support every environment</li>
        <li>detect every possible configuration issue</li>
        <li>prevent every possible data loss scenario</li>
        <li>remain compatible with every third-party tool or service</li>
      </ul>
      <p>
        Nothing in these Terms excludes rights or protections that cannot
        legally be excluded.
      </p>

      <h2>14. Limitation of Liability</h2>
      <p>
        To the maximum extent permitted by applicable law, Corotum is not
        responsible for indirect or consequential losses resulting from:
      </p>
      <ul>
        <li>user configuration</li>
        <li>unavailable Git repositories</li>
        <li>third-party software or services</li>
        <li>unauthorized access caused by compromised user credentials</li>
        <li>use of unsupported environments</li>
        <li>actions performed outside Corotum</li>
        <li>
          loss or modification of files where adequate backups were not
          maintained
        </li>
      </ul>
      <p>
        Nothing in this section limits liability where such limitation is
        prohibited by applicable law.
      </p>

      <h2>15. Termination</h2>
      <p>You may stop using Corotum at any time.</p>
      <p>
        Where account deletion functionality is available, you may delete your
        account.
      </p>
      <p>We may suspend or terminate access where necessary because of:</p>
      <ul>
        <li>material violation of these Terms</li>
        <li>unlawful use</li>
        <li>abuse of the service</li>
        <li>significant security risks</li>
        <li>attempts to compromise Corotum or other users</li>
      </ul>
      <p>
        Termination of access to Corotum Cloud does not revoke rights granted
        under AGPLv3 for open source Corotum software.
      </p>

      <h2>16. Changes to These Terms</h2>
      <p>
        We may update these Terms as Corotum evolves or where necessary because
        of legal, technical, security, or operational changes.
      </p>
      <p>
        The current version will be published on corotum.com together with its
        effective date.
      </p>
      <p>
        Continued use of the service after an updated version becomes effective
        constitutes acceptance of the updated Terms where permitted by
        applicable law.
      </p>

      <h2>17. Governing Law</h2>
      <p>These Terms are governed by Polish law.</p>
      <p>
        Mandatory consumer protection rules applicable to a user remain
        unaffected.
      </p>

      <h2>18. Contact</h2>
      <p>Questions regarding these Terms may be sent to:</p>
      <p>
        <strong>contact@corotum.com</strong>
      </p>
    </LegalDocument>
  );
}
