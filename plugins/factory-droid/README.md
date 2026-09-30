# factory-droid

An [oh-my-pi (omp)](https://github.com/can1357/oh-my-pi) provider plugin for Factory Droid. It lets a Factory account use its Droid models from omp without installing the Droid CLI.

## Install

```sh
omp plugin marketplace add DusKing1/omp-plugins
omp plugin install factory-droid@dusking1
```

Restart omp, then:

```text
/login factory-droid
/model factory-droid/<model-id>
```

Login uses Factory's device-code flow: omp shows a URL and a code, you approve it in the browser, and omp stores and refreshes the token like any other OAuth provider. Factory access tokens last 24 hours; when a session starts with an expired one, the plugin renews it right away through omp and refetches the model list, so you only log in again if Factory revokes the login.

## What it does

- Ships the concrete model list from Droid CLI 0.228.0, including Claude, GPT, Gemini, GLM, Kimi, MiniMax, Mistral, Qwen, DeepSeek and Grok models.
- Filters that list per account using Factory's feature flags and organization model policy, so omp only offers models your account can use.
- Sends each model through its matching Factory gateway protocol: Anthropic Messages, OpenAI Responses, Chat Completions or Gemini.
- Routes EU-resident accounts to `api.eu.factory.ai` and follows Factory's per-region upstream routing.

## Network and privacy

- Requests go only to `api.workos.com` (login and token refresh) and `api.factory.ai` / `api.eu.factory.ai` (account region, model policy and inference).
- Credentials live in omp's own credential store. The plugin reads no local files, environment variables or other tools' configs, and sends no telemetry.
- Factory's gateway expects the Droid CLI client, so requests carry the same public client ID, user agent and Droid system-prompt prefix that every Droid CLI sends. Your organization ID comes from your own token; nothing account-specific is hardcoded.

This project is not affiliated with Factory. Using it is subject to your Factory plan and terms.

## Compatibility

Requires omp 18.3.3 or newer; tested with omp 18.4.4 on Windows. A native `factory-droid` provider for omp is proposed in [can1357/oh-my-pi#13276](https://github.com/can1357/oh-my-pi/pull/13276). If your omp release includes it, uninstall this plugin: both use the provider ID `factory-droid`, and the plugin's registration replaces the native provider's models.

## Credits

Model registry and routing are adapted from [@will-bogusz](https://github.com/will-bogusz)'s native provider ([can1357/oh-my-pi#8577](https://github.com/can1357/oh-my-pi/pull/8577)) and oh-my-pi's own provider code, all MIT licensed. See [LICENSE](../../LICENSE).
