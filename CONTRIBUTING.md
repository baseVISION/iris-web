# Contributing to baseVISION iris-web

This is a fork of [dfir-iris/iris-web](https://github.com/dfir-iris/iris-web) maintained by baseVISION.

## Issues
Please try to follow the templates provided for feature requests and bugs.

If you want to report a security issue, please read the [security page](./SECURITY.md).

## Pull requests
Please follow the [code guideline](./CODESTYLE.md) when writing your code.

### Internal contributors (baseVISION team)
- Branch from `bv-develop` and open a PR targeting `bv-develop`.
- Use the commit prefix convention from `BV-DEV-CONCEPT.md` (`[FIX]`, `[IMP]`, `[ADD]`, `[BV]`, `[BV-FIX]`).
- Commits without a `[BV]` prefix must be clean enough to submit upstream without modification.

### Contributing back to upstream
- Branch from `upstream/develop` (not from `bv-develop`) using the naming convention `contrib/<name>`.
- Only cherry-pick commits that have **no** `[BV]` prefix.
- Open the PR on [dfir-iris/iris-web](https://github.com/dfir-iris/iris-web) targeting their `develop` branch.
- Delete the `contrib/` branch after upstream merge.

## Others
If you have any ideas not directly linked to the code itself, you can contact us by [email](mailto:contact@dfir-iris.org).
