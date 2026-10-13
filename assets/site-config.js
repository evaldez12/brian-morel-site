/*
  Site settings. Fill these in once, and every page picks them up.
  Anything left blank shows a highlighted [placeholder] on the legal pages
  or simply switches that feature off (pixel, booking embed, spam check).
  Secrets (GoHighLevel token, Meta access token) never go here. They live in
  Cloudflare Pages > Settings > Environment variables. See LAUNCH notes.
*/
window.SITE_CONFIG = {
  brandName: 'Brian Morel Credit & Funding',
  legalName: '',            // e.g. 'Morel Credit & Funding LLC' once the LLC is formed
  ownerName: 'Brian Morel',
  mailingAddress: '',       // Bizee virtual address or office address, used on legal pages
  phone: '',                // E.164 for links, e.g. '+12125550100'
  phoneDisplay: '',         // e.g. '(212) 555-0100'
  email: '',                // e.g. 'brian@yourdomain.com' (free via Cloudflare Email Routing)
  instagram: 'https://instagram.com/ceoteddy_',
  smsProgramName: '',       // e.g. 'Morel Credit & Funding Client Updates'
  effectiveDate: '',        // date the legal pages take effect, e.g. 'January 5, 2027'

  bookingEmbedUrl: '',      // GoHighLevel calendar link, shown on the thank-you page
  metaPixelId: '',          // Meta Pixel ID; leave blank until the ad account exists
  turnstileSiteKey: '',     // optional Cloudflare Turnstile spam check (free)

  fundingFeeTerms: '',      // e.g. 'X% of approved funding, due only after you are funded'
  giveaway: {
    startDate: '',          // e.g. 'January 6, 2027'
    endDate: '',            // e.g. 'January 19, 2027'
    endDateISO: '',         // e.g. '2027-01-19T23:59:00-05:00', drives the countdown
    drawingDate: '',        // e.g. 'January 20, 2027'
    eligibleStates: 'New York, New Jersey, and Connecticut',
    prize1Value: '',        // approximate retail value, e.g. '$1,494'
    prize2Value: '',
    prize3Value: '',
    totalValue: ''          // must stay under $5,000 (NY registration and bond threshold)
  }
};
