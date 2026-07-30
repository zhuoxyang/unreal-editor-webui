const [major, minor, patch] = process.versions.node.split('.').map(Number)

const supported =
  (major === 20 && minor >= 19) ||
  (major === 22 && minor >= 13) ||
  major >= 24

if (!supported) {
  console.error(
    `Unsupported Node.js ${process.versions.node}. ` +
    'Expected ^20.19.0, ^22.13.0, or >=24 as declared by frontend/package.json.',
  )
  process.exitCode = 1
} else {
  console.log(`Node.js ${major}.${minor}.${patch} satisfies the frontend engine requirement.`)
}
