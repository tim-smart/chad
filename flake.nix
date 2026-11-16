{
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";
  };

  outputs = {nixpkgs, ...}: let
    forAllSystems = function:
      nixpkgs.lib.genAttrs nixpkgs.lib.systems.flakeExposed
      (system: function nixpkgs.legacyPackages.${system});
  in {
    formatter = forAllSystems (pkgs: pkgs.alejandra);
    devShells = forAllSystems (pkgs: {
      default = pkgs.mkShell {
        packages = with pkgs; [
          git
          nodejs_26
          pnpm_12
          # `script`, which gives a scenario's command a terminal.
          util-linux
          # The Kubernetes checks of scripts/kubernetes.ts, run by hand against a cluster.
          kubectl
        ];
      };
    });
  };
}
