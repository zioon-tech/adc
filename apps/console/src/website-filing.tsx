export const icpFiling = {
  number: "赣ICP备2026025481号-1",
  url: "https://beian.miit.gov.cn/"
} as const;

export function WebsiteFiling() {
  return (
    <nav className="website-filing" aria-label="网站备案">
      <a href={icpFiling.url} target="_blank" rel="noreferrer">
        {icpFiling.number}
      </a>
      <a href="https://beian.mps.gov.cn/#/query/webSearch?code=33011002020851"
        target="_blank" rel="noreferrer">
        <img src="/assets/public-security-filing.png" width="18" height="20" alt="" aria-hidden="true" />
        浙公网安备33011002020851号
      </a>
    </nav>
  );
}
