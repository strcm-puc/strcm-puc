export default function PrivacyPolicy() {
  return (
    <main className="max-w-2xl mx-auto px-6 py-12 text-gray-800">
      <h1 className="text-2xl font-semibold mb-2">Privacy Policy — STRCM PUC / ST-APEX</h1>
      <p className="text-sm text-gray-500 mb-8">Last updated: 2 July 2026</p>

      <p className="mb-4">
        STRCM PUC (&quot;we&quot;, &quot;us&quot;) operates the ST-APEX customer loyalty program for our
        retail store in Tarapur, Munger, Bihar.
      </p>

      <h2 className="text-lg font-semibold mt-8 mb-2">Information we collect:</h2>
      <ul className="list-disc pl-6 mb-4 space-y-1">
        <li>Your mobile phone number, used as your unique account identifier</li>
        <li>Your name, as provided at time of registration or first purchase</li>
        <li>Your purchase history at our store (products, amounts, dates)</li>
        <li>Your language preference (Hindi or English)</li>
      </ul>

      <h2 className="text-lg font-semibold mt-8 mb-2">How we use this information:</h2>
      <ul className="list-disc pl-6 mb-4 space-y-1">
        <li>To calculate and credit loyalty rewards (ST Rupees) on your purchases</li>
        <li>To send you WhatsApp messages about your rewards, balance, and personalized offers</li>
        <li>To display your personal rewards dashboard when you access your account link</li>
      </ul>

      <p className="mb-4">
        We do not sell or share your personal information with any third party for
        marketing purposes. Your data is stored securely and used only to operate
        this loyalty program.
      </p>

      <p className="mb-4">
        You can stop receiving messages at any time by replying STOP to any message
        we send you.
      </p>

      <p>
        For any questions about your data or this policy, contact us at{' '}
        <a href="mailto:strcmpuc.systems@gmail.com" className="underline">
          strcmpuc.systems@gmail.com
        </a>{' '}
        or visit our store.
      </p>
    </main>
  );
}
