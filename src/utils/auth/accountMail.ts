import transporter from "../../lib/nodemailer.js";

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ] as string,
  );

const emailTemplate = (content: string) => `
  <div style="background-color: #F4ECE4; padding: 40px 20px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
    <div style="max-width: 520px; margin: 0 auto; background-color: #FFFFFF; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(29, 69, 51, 0.06); border: 1px solid #EAE2D8;">

      <!-- Header -->
      <div style="background-color: #1D4533; padding: 28px 32px; text-align: center;">
        <h1 style="color: #FFFFFF; font-size: 22px; font-weight: 700; margin: 0; letter-spacing: -0.5px;">Relay</h1>
      </div>

      <!-- Content -->
      <div style="padding: 36px 32px;">
        ${content}
      </div>

      <!-- Footer -->
      <div style="background-color: #FAFAFA; padding: 20px 32px; text-align: center; border-top: 1px solid #EFEAE4;">
        <p style="color: #A0AEC0; font-size: 12px; margin: 0;">&copy; ${new Date().getFullYear()} Relay. All rights reserved.</p>
      </div>

    </div>
  </div>
`;

export const sendPasswordChangedEmail = async (to: string, name: string) => {
  try {
    const mailOptions = {
      from: `"Relay App" <${process.env.SENDER_EMAIL || process.env.BREVO_SMTP_USER}>`,
      to,
      subject: "Your Relay password was changed",
      html: emailTemplate(`
        <p style="color: #4A5568; font-size: 15px; line-height: 1.6; margin-top: 0; margin-bottom: 16px;">
          Hi ${escapeHtml(name)},
        </p>

        <h2 style="color: #1D4533; font-size: 20px; font-weight: 600; margin-top: 0; margin-bottom: 16px;">
          Your password was changed
        </h2>

        <p style="color: #4A5568; font-size: 15px; line-height: 1.6; margin-top: 0; margin-bottom: 24px;">
          The password for your Relay account was just changed, and you were signed out of your other devices.
        </p>

        <div style="background-color: #F7EAE0; border: 1px solid #E6D4C5; border-radius: 12px; padding: 16px 20px; margin-bottom: 24px;">
          <p style="color: #1D4533; font-size: 14px; line-height: 1.6; margin: 0;">
            If this wasn't you, reset your password straight away.
          </p>
        </div>
      `),
    };

    await transporter.sendMail(mailOptions);
    console.log(`Password Changed email sent successfully to ${to}`);
  } catch (error) {
    console.error("Password changed email failed:", error);
  }
};

export const sendEmailChangedNotice = async (
  to: string,
  newEmail: string,
  name: string,
) => {
  try {
    const mailOptions = {
      from: `"Relay App" <${process.env.SENDER_EMAIL || process.env.BREVO_SMTP_USER}>`,
      to,
      subject: "Your Relay email address was changed",
      html: emailTemplate(`
        <p style="color: #4A5568; font-size: 15px; line-height: 1.6; margin-top: 0; margin-bottom: 16px;">
          Hi ${escapeHtml(name)},
        </p>

        <h2 style="color: #1D4533; font-size: 20px; font-weight: 600; margin-top: 0; margin-bottom: 16px;">
          Your email address was changed
        </h2>

        <p style="color: #4A5568; font-size: 15px; line-height: 1.6; margin-top: 0; margin-bottom: 24px;">
          The email address on your Relay account was just changed to
          <strong style="color: #1D4533;">${escapeHtml(newEmail)}</strong>,
          and you were signed out of your other devices.
        </p>

        <div style="background-color: #F7EAE0; border: 1px solid #E6D4C5; border-radius: 12px; padding: 16px 20px; margin-bottom: 24px;">
          <p style="color: #1D4533; font-size: 14px; line-height: 1.6; margin: 0;">
            If this wasn't you, contact support straight away.
          </p>
        </div>
      `),
    };

    await transporter.sendMail(mailOptions);
  } catch (error) {
    console.error("Email changed notice failed:", error);
  }
};
