{
  description = "R3DVoice";

  inputs = {
    flake-parts.url = "github:hercules-ci/flake-parts";
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
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
          pkgs,
          system,
          lib,
          ...
        }:
        let
          pnpm = pkgs.pnpm_11;
          electron = (pkgs.callPackage ./nix/electron/default.nix { }).electron_43-bin;
          nodejs = pkgs.nodejs_24;
          prisma = pkgs.prisma-engines_6;
        in
        {
          packages.R3DVoice = pkgs.stdenv.mkDerivation (finalAttrs: {
            pname = "R3DVoice";
            version = "0.15.0";
            src = ./.;

            nativeBuildInputs = [
              nodejs
              pkgs.pnpmConfigHook
              pnpm
              prisma
              pkgs.makeWrapper
            ];

            pnpmDeps = pkgs.fetchPnpmDeps {
              inherit (finalAttrs) pname version src;
              inherit pnpm;
              fetcherVersion = 4;
              hash = "sha256-blzDVTttVC7s/WvAsbsfHVcRUi61hRmBA7GRCBUtTbQ=";
            };

            env = {
              PRISMA_QUERY_ENGINE_LIBRARY = "${prisma}/lib/libquery_engine.node";
              PRISMA_QUERY_ENGINE_BINARY = "${prisma}/bin/query-engine";
              PRISMA_SCHEMA_ENGINE_BINARY = "${prisma}/bin/schema-engine";
              PRISMA_FMT_BINARY = "${prisma}/bin/prisma-fmt";
            };

            buildPhase = ''
              runHook preBuild
              pnpm --filter @redvoice/shared build
              pnpm --filter @redvoice/server exec prisma generate
              pnpm --filter @redvoice/server build
              pnpm --filter @redvoice/client run build
              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall

              mkdir -p $out/share/r3dvoice
              cp -r node_modules $out/share/r3dvoice/node_modules

              mkdir -p $out/share/r3dvoice/apps/client $out/share/r3dvoice/apps/server $out/share/r3dvoice/packages/shared

              cp -r apps/client/out $out/share/r3dvoice/apps/client/out
              cp apps/client/package.json $out/share/r3dvoice/apps/client/package.json
              cp -r apps/client/node_modules $out/share/r3dvoice/apps/client/node_modules

              cp -r apps/server/dist $out/share/r3dvoice/apps/server/dist
              cp apps/server/package.json $out/share/r3dvoice/apps/server/package.json
              cp -r apps/server/node_modules $out/share/r3dvoice/apps/server/node_modules

              cp -r packages/shared/dist $out/share/r3dvoice/packages/shared/dist
              cp packages/shared/package.json $out/share/r3dvoice/packages/shared/package.json
              cp -r packages/shared/node_modules $out/share/r3dvoice/packages/shared/node_modules

              makeWrapper ${electron}/bin/electron $out/bin/r3dvoice \
                --add-flags "$out/share/r3dvoice/apps/client" \
                --set NODE_ENV production

              runHook postInstall
            '';
          });

          packages.default = self'.packages.R3DVoice;

          apps.default = {
            type = "app";
            program = "${self'.packages.R3DVoice}/bin/r3dvoice";
          };

          devShells.default = pkgs.mkShell {
            inputsFrom = [ self'.packages.R3DVoice ];
            packages = [
              pnpm
              nodejs
              pkgs.pkg-config
              electron
            ];
          };
        };
    };
}
