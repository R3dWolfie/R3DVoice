{
  description = "Description for the project";

  inputs = {
    flake-parts.url = "github:hercules-ci/flake-parts";
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [
      ];
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
        "x86_64-darwin"
      ];
      perSystem =
        {
          config,
          self',
          inputs',
          pkgs,
          system,
          ...
        }:
        {
          packages.R3DVoice = pkgs.stdenv.mkDerivation (
            finalAttrs:
            let
              pnpm = pkgs.pnpm_11;
            in
            {
              pname = "R3DVoice";
              version = "0.13.3";

              src = ./.;

              nativeBuildInputs = [
                pkgs.nodejs # in case scripts are run outside of a pnpm call
                pkgs.pnpmConfigHook
                pnpm # At least required by pnpmConfigHook, if not other (custom) phases
              ];

              pnpmDeps = pkgs.fetchPnpmDeps {
                inherit (finalAttrs) pname version src;
                inherit pnpm;
                fetcherVersion = 4;
                hash = "sha256-jNnoHN80t7Rbh/aoGcFL5l4vaWJaoFss7Y1WFnH2/Js=";
              };
            }
          );
          packages.default = self'.packages.R3DVoice;
        };
      flake = {
      };
    };
}
