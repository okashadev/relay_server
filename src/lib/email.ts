import transporter from "./nodemailer.js";

export const sendVerificationEmail = async (email: string, code: string) => {
  try {
    const mailOptions = {
      from: `"Relay App" <${process.env.SENDER_EMAIL || process.env.SMTP_USER}>`,
      to: email,
      subject: "Verify Your Email - Relay",
      html: `
        <div style="background-color: #F4ECE4; padding: 40px 20px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
          <div style="max-width: 520px; margin: 0 auto; background-color: #FFFFFF; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(29, 69, 51, 0.06); border: 1px solid #EAE2D8;">
            
            <!-- Header Brand -->
            <div style="background-color: #1D4533; padding: 28px 32px; text-align: center;">
              <h1 style="color: #FFFFFF; font-size: 22px; font-weight: 700; margin: 0; letter-spacing: -0.5px;">Relay</h1>
            </div>
            
            <!-- Content Body -->
            <div style="padding: 36px 32px;">
              <h2 style="color: #1D4533; font-size: 20px; font-weight: 600; margin-top: 0; margin-bottom: 16px;">Verify your email address</h2>
              <p style="color: #4A5568; font-size: 15px; line-height: 1.6; margin-top: 0; margin-bottom: 24px;">
                Welcome to Relay! Please use the secure verification code below to complete your registration. This code will expire in <strong>15 minutes</strong>.
              </p>
              
              <!-- Code Box -->
              <div style="background-color: #F7EAE0; border: 1px solid #E6D4C5; border-radius: 12px; padding: 20px; text-align: center; margin-bottom: 28px;">
                <span style="font-family: monospace, monospace; font-size: 32px; font-weight: 700; color: #1D4533; letter-spacing: 6px;">${code}</span>
              </div>
              
              <p style="color: #718096; font-size: 13px; line-height: 1.5; margin: 0;">
                If you didn't request this verification, you can safely ignore this email. Someone may have typed your email address by mistake.
              </p>
            </div>
            
            <!-- Footer -->
            <div style="background-color: #FAFAFA; padding: 20px 32px; text-align: center; border-top: 1px solid #EFEAE4;">
              <p style="color: #A0AEC0; font-size: 12px; margin: 0;">&copy; ${new Date().getFullYear()} Relay. All rights reserved.</p>
            </div>
            
          </div>
        </div>
      `,
    };

    await transporter.sendMail(mailOptions);
    console.log(`Verification email sent successfully to ${email}`);
  } catch (error) {
    console.error("Error sending verification email:", error);
    throw new Error("Failed to send verification email.");
  }
};
