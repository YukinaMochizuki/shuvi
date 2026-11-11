# Vendored Hangar API code

Generated TypeScript (protoc-gen-es v2.16.0, `target=ts`) from the hangar protos at
`8535f56fe7c10e4bbe4186952774b460d2f03c1a`. Only what the computer capability uses, with the files it
imports:

| File | From the proto |
|---|---|
| `hangar/compute/v1alpha1/container_pb.ts` | `hangar/compute/v1alpha1/container.proto` |
| `hangar/compute/v1alpha1/machine_capability_pb.ts` | `hangar/compute/v1alpha1/machine_capability.proto` (exec) |
| `hangar/compute/v1alpha1/interface_pb.ts`, `placement_pb.ts` | imported by `container_pb.ts` |
| `hangar/storage/v1alpha1/disk_pb.ts` | `hangar/storage/v1alpha1/disk.proto` |
| `hangar/secrets/v1alpha1/secret_pb.ts` | `hangar/secrets/v1alpha1/secret.proto` (the registry login) |
| `hangar/meta/v1/meta_pb.ts`, `options_pb.ts` | imported by the above |

One change from what the generator writes: the `go_package` file option is removed from each embedded file
descriptor (decoded, cleared, encoded again), because it names where the Go code lives, which this public
repository does not need and should not carry. Nothing reads that option at run time.

Do not edit these files by hand. To update them, generate the same files with protoc-gen-es from the hangar
protos at a newer commit, remove `go_package` from their descriptors the same way, change the sha above, and
keep `@bufbuild/protobuf` in package.json at the version the generator targets.
