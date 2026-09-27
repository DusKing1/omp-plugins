# omp-plugins

Plugins for [oh-my-pi (omp)](https://github.com/can1357/oh-my-pi), installed through omp's marketplace.

| Plugin | Description |
| --- | --- |
| [`factory-droid`](plugins/factory-droid) | Use Factory Droid models in omp: device-code login, model discovery and Factory gateway routing |

## Install

```sh
omp plugin marketplace add DusKing1/omp-plugins
omp plugin install factory-droid@dusking1
```

Inside omp, the same commands are `/marketplace add DusKing1/omp-plugins` and `/marketplace install factory-droid@dusking1`. Restart omp afterwards; extension plugins load at startup.

## Update

```sh
omp plugin marketplace update dusking1
omp plugin upgrade factory-droid@dusking1
```

To install new versions automatically at startup, set `marketplace.autoUpdate` to `auto` in omp's settings. Updates take effect in the next session.

## Uninstall

```sh
omp plugin uninstall factory-droid@dusking1
```
