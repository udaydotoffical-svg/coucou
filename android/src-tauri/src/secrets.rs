// claude.rs asks for keys through this module; on Android they live in store.rs.
pub fn get(key: &str) -> Option<String> {
    crate::store::secret_get(key)
}
