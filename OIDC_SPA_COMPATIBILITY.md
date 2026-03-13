# oidc-spa compatibility with GitLab OAuth and GitHub OAuth

This repository only needs a bearer access token (`token`) for both providers:

- `github({ token, owner, repo })`
- `gitlab({ token, projectId })`

So the question is whether `oidc-spa` can obtain the right token from each provider.

## What we verified in `keycloakify/oidc-spa`

From the source in `src/core/createOidc.ts` and `src/core/OidcMetadata.ts`:

- `oidc-spa` is designed for **OpenID Connect** providers.
- It discovers provider metadata from:
  - `${issuerUri}/.well-known/openid-configuration`
- It expects OIDC semantics (including `openid` scope and ID token handling).

## Conclusion

### GitLab OAuth

✅ **Possible** with `oidc-spa`, as long as you configure GitLab as an OIDC provider (issuer URI + OIDC client) and request scopes needed for GitLab API access.

Use the returned `accessToken` directly with this package's GitLab provider.

### GitHub OAuth (OAuth App)

❌ **Not directly possible** with `oidc-spa` for the classic GitHub OAuth App flow, because that flow is OAuth2 but not full OIDC in the way `oidc-spa` expects.

If you need GitHub access with this package, use another way to obtain a GitHub API token (or broker GitHub auth through an OIDC-capable identity provider) and pass that token to the GitHub provider.

## Practical integration shape

```ts
const { accessToken } = await oidc.getTokens();

// GitLab (supported with oidc-spa when GitLab is configured as OIDC issuer)
const gitlabProvider = gitlab({
  token: accessToken,
  projectId: '123',
});

// GitHub (works in git-fs if token is valid GitHub API token,
// but oidc-spa is not the right source for classic GitHub OAuth App tokens)
const githubProvider = github({
  token: accessToken,
  owner: 'acme',
  repo: 'website',
});
```
