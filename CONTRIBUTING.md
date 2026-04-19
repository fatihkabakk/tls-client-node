# Contributing

## Scope

Issues and pull requests are welcome for bug fixes, documentation improvements, compatibility updates, and focused feature work.

Open an issue first if the proposed change is large, invasive, or changes public behavior.

## Local development

```sh
yarn install
yarn run ci:check
```

`yarn run ci:check` runs the validation expected for pull requests.

## Pull requests

- Target `dev` unless you are asked to use a different base branch.
- Keep each pull request narrow in scope.
- Include validation details in the pull request description.
- Update documentation when the public API or behavior changes.


## Branches

- `dev` is the default base branch for external contributions.
- `test` and `master` are reserved for project integration and release work.

Release operations are handled separately from external contribution flow.